// Regenerate from repository root: xcrun swift frontend/scripts/make-ios-icon.swift
import AppKit
let side = 1024
let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
NSColor(srgbRed: 0.25, green: 0.20, blue: 0.77, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: side, height: side).fill()
let card = NSBezierPath(roundedRect: NSRect(x: 166, y: 160, width: 692, height: 704), xRadius: 64, yRadius: 64)
NSColor.white.withAlphaComponent(0.12).setFill(); card.fill()
let v = NSBezierPath()
v.move(to: NSPoint(x: 285, y: 725)); v.line(to: NSPoint(x: 405, y: 725)); v.line(to: NSPoint(x: 512, y: 425))
v.line(to: NSPoint(x: 619, y: 725)); v.line(to: NSPoint(x: 739, y: 725)); v.line(to: NSPoint(x: 570, y: 300))
v.line(to: NSPoint(x: 454, y: 300)); v.close(); NSColor.white.setFill(); v.fill()
NSColor(srgbRed: 1, green: 0.73, blue: 0.28, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 340, y: 225, width: 344, height: 30), xRadius: 15, yRadius: 15).fill()
NSGraphicsContext.restoreGraphicsState()
let url = URL(fileURLWithPath: "frontend/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
try image.representation(using: .png, properties: [:])!.write(to: url)
