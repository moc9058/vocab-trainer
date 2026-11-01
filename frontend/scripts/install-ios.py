#!/usr/bin/env python3
"""Build, validate and update a development app without deleting its data."""
import argparse
import datetime as dt
import fnmatch
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile

FRONTEND = Path(__file__).resolve().parents[1]
BUNDLE_ID = 'jp.moc9058.vocabtrainer'


def run(*args, capture=False):
    return subprocess.check_output(args, stderr=subprocess.PIPE) if capture else subprocess.run(args, check=True)


def permits(allowed, value):
    if isinstance(value, str) and isinstance(allowed, str):
        return fnmatch.fnmatchcase(value, allowed)
    if isinstance(value, list) and isinstance(allowed, list):
        return all(any(permits(a, v) for a in allowed) for v in value)
    if isinstance(value, dict) and isinstance(allowed, dict):
        return all(k in allowed and permits(allowed[k], v) for k, v in value.items())
    return type(value) is type(allowed) and value == allowed


def validate(app, device):
    run('codesign', '--verify', '--deep', '--strict', str(app))
    profile = plistlib.loads(run('security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision'), capture=True))
    expiry = profile['ExpirationDate'].replace(tzinfo=dt.timezone.utc)
    now = dt.datetime.now(dt.timezone.utc)
    if expiry <= now:
        raise ValueError('Provisioning profile expired. Rebuild with automatic signing; do not reinstall this bundle.')
    if device not in profile.get('ProvisionedDevices', []):
        raise ValueError('This development profile does not include the specified device UDID.')
    entitlements = plistlib.loads(run('codesign', '-d', '--entitlements', ':-', str(app), capture=True))
    if not permits(profile['Entitlements'], entitlements):
        raise ValueError('Signed entitlements are not permitted by the provisioning profile.')
    with (app / 'Info.plist').open('rb') as stream:
        bundle = plistlib.load(stream)['CFBundleIdentifier']
    if bundle != BUNDLE_ID or not entitlements.get('application-identifier', '').endswith('.' + bundle):
        raise ValueError('Unexpected bundle ID or signed application identifier.')
    with tempfile.TemporaryDirectory(prefix='vocab-signature-') as directory:
        prefix = str(Path(directory) / 'cert')
        run('codesign', '-d', '--extract-certificates=' + prefix, str(app), capture=True)
        cert = Path(prefix + '0')
        if cert.read_bytes() not in profile['DeveloperCertificates']:
            raise ValueError('Signing certificate is not included in this provisioning profile.')
        run('openssl', 'x509', '-inform', 'DER', '-in', str(cert), '-checkend', '0', '-noout', capture=True)
    print(f'Signature/profile/device checks passed. Profile expires: {expiry.isoformat()}', flush=True)
    if expiry - now < dt.timedelta(days=1):
        print('WARNING: profile expires in less than 24 hours. Personal Team profiles last only 7 days.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', required=True, help='Physical iPhone UDID (not display name)')
    parser.add_argument('--check-only', type=Path, metavar='APP', help='Validate an existing .app without build/install')
    args = parser.parse_args()
    if args.check_only:
        validate(args.check_only.resolve(), args.device)
        return
    os.environ.setdefault('DEVELOPER_DIR', '/Applications/Xcode.app/Contents/Developer')
    os.chdir(FRONTEND)
    run('npm', 'run', 'ios:sync')
    with tempfile.TemporaryDirectory(prefix='vocab-ios-build-') as directory:
        run('xcodebuild', '-packageAuthorizationProvider', 'netrc', '-project', 'ios/App/App.xcodeproj',
            '-scheme', 'App', '-configuration', 'Debug', '-destination', f'id={args.device}',
            '-derivedDataPath', directory, '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration', 'build')
        app = Path(directory) / 'Build/Products/Debug-iphoneos/App.app'
        validate(app, args.device)
        run('xcrun', 'devicectl', 'device', 'install', 'app', '--device', args.device, str(app))
        print('Installed. Checking launch separately…', flush=True)
        try:
            run('xcrun', 'devicectl', 'device', 'process', 'launch', '--device', args.device, BUNDLE_ID)
        except subprocess.CalledProcessError:
            print('Installation succeeded, but launch did not. Unlock the iPhone. If Security/trust is reported, '
                  'open Settings > General > VPN & Device Management and trust the developer; '
                  'keep Internet access enabled. Developer Mode must also be enabled.', file=sys.stderr)
            raise
        print('Installation and launch succeeded.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'iOS update failed: {error}', file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr.decode(errors='replace'), file=sys.stderr)
        sys.exit(1)
