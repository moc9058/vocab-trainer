"""Regression tests for rejecting bundles before device installation."""
import datetime as dt
import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('install_ios', Path(__file__).with_name('install-ios.py'))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class SigningValidationTests(unittest.TestCase):
    def setUp(self):
        self.profile = {
            'ExpirationDate': dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) + dt.timedelta(days=7),
            'ProvisionedDevices': ['test-udid'],
            'Entitlements': {'application-identifier': 'TEAM.jp.moc9058.vocabtrainer', 'get-task-allow': True},
            'DeveloperCertificates': [b'certificate'],
        }
        self.entitlements = self.profile['Entitlements'].copy()

    def fake_run(self, *args, capture=False):
        if args[0] == 'security':
            return plistlib.dumps(self.profile)
        if '--entitlements' in args:
            return plistlib.dumps(self.entitlements)
        if len(args) > 2 and args[2].startswith('--extract-certificates='):
            Path(args[2].split('=', 1)[1] + '0').write_bytes(b'certificate')
        return b''

    def validate(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            (app / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': installer.BUNDLE_ID}))
            with patch.object(installer, 'run', side_effect=self.fake_run):
                installer.validate(app, 'test-udid')

    def test_valid_bundle(self):
        self.validate()

    def test_expired_profile_is_rejected(self):
        self.profile['ExpirationDate'] -= dt.timedelta(days=8)
        with self.assertRaisesRegex(ValueError, 'expired'):
            self.validate()

    def test_wrong_device_is_rejected(self):
        self.profile['ProvisionedDevices'] = ['other-udid']
        with self.assertRaisesRegex(ValueError, 'UDID'):
            self.validate()

    def test_extra_entitlement_is_rejected(self):
        self.entitlements['com.apple.security.application-groups'] = ['unexpected']
        with self.assertRaisesRegex(ValueError, 'entitlements'):
            self.validate()

    def test_wrong_certificate_is_rejected(self):
        self.profile['DeveloperCertificates'] = [b'other-certificate']
        with self.assertRaisesRegex(ValueError, 'certificate'):
            self.validate()


if __name__ == '__main__':
    unittest.main()
