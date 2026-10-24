// Moves the mouse and presses keys in a window, for recording the demo video
// (see record.sh). Positions are in points from the window's top-left corner.
// Keys it presses show in a label at the bottom centre of the window, so the
// recording picks them up.
//
//   swiftc -O drive.swift -o drive
//   drive <pid> bounds                      # print the window's x,y,w,h
//   drive <pid> move X Y | click X Y | cmdclick X Y | drag X1 Y1 X2 Y2
//               | toggle | wait SECONDS ...
//
// Needs the Accessibility permission for the terminal it runs from.

import AppKit
import CoreGraphics

let args = CommandLine.arguments
let pid = Int(args[1])!

// The app's largest on-screen window, in screen coordinates (top-left origin).
func window() -> CGRect {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  var best: CGRect? = nil
  for w in list where (w[kCGWindowOwnerPID as String] as? Int) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
    let b = w[kCGWindowBounds as String] as! [String: Double]
    let r = CGRect(x: b["X"]!, y: b["Y"]!, width: b["Width"]!, height: b["Height"]!)
    if best == nil || r.width * r.height > best!.width * best!.height { best = r }
  }
  guard let r = best else { fatalError("no window for pid \(pid)") }
  return r
}

let frame = window()
if args.count > 2 && args[2] == "bounds" {
  print("\(Int(frame.minX)),\(Int(frame.minY)),\(Int(frame.width)),\(Int(frame.height))")
  exit(0)
}

// MARK: Key label

// A light rounded label that never takes focus or clicks.
final class Caption {
  let panel: NSPanel
  let label = NSTextField(labelWithString: "")
  var shown = 0

  init() {
    panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                    backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .statusBar
    panel.ignoresMouseEvents = true
    panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
    panel.alphaValue = 0

    let box = NSView()
    box.wantsLayer = true
    box.layer!.backgroundColor = NSColor(white: 0.97, alpha: 0.92).cgColor
    box.layer!.cornerRadius = 20
    box.layer!.borderWidth = 1
    box.layer!.borderColor = NSColor(white: 0, alpha: 0.08).cgColor
    label.font = .systemFont(ofSize: 38, weight: .semibold)
    label.textColor = NSColor(white: 0.12, alpha: 1)
    box.addSubview(label)
    panel.contentView = box
  }

  // Shows text, then fades it out after `seconds` unless shown again.
  func show(_ text: String, for seconds: Double) {
    DispatchQueue.main.sync {
      shown += 1
      let id = shown
      label.stringValue = text
      label.sizeToFit()
      let size = CGSize(width: label.frame.width + 64, height: label.frame.height + 30)
      label.setFrameOrigin(CGPoint(x: 32, y: 15))
      // Bottom centre of the window, converted to AppKit's bottom-left origin.
      let screenHeight = NSScreen.screens[0].frame.height
      let bottom = frame.maxY - 70
      panel.setFrame(CGRect(x: frame.midX - size.width / 2, y: screenHeight - bottom,
                            width: size.width, height: size.height), display: true)
      panel.orderFrontRegardless()
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = 0.12
        panel.animator().alphaValue = 1
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [self] in
        guard id == shown else { return }
        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = 0.3
          panel.animator().alphaValue = 0
        }
      }
    }
  }
}

// MARK: Input

let src = CGEventSource(stateID: .hidSystemState)
var pos = CGEvent(source: nil)!.location
var flags: CGEventFlags = []

func post(_ type: CGEventType, _ p: CGPoint) {
  let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)!
  e.flags = flags
  e.post(tap: .cghidEventTap)
}

// Eased movement, so the pointer glides like a hand moved it.
func glide(to p: CGPoint, dragging: Bool = false, ms: Double = 450) {
  let steps = max(10, Int(ms / 12))
  let a = pos
  for i in 1...steps {
    var t = Double(i) / Double(steps)
    t = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    post(dragging ? .leftMouseDragged : .mouseMoved,
         CGPoint(x: a.x + (p.x - a.x) * t, y: a.y + (p.y - a.y) * t))
    usleep(12_000)
  }
  pos = p
}

func setFlags(_ f: CGEventFlags) {
  flags = f
  let e = CGEvent(source: src)!
  e.type = .flagsChanged
  e.flags = f
  e.location = pos
  e.post(tap: .cghidEventTap)
}

func key(_ code: CGKeyCode, _ f: CGEventFlags) {
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)!
    e.flags = f
    e.post(tap: .cghidEventTap)
    usleep(30_000)
  }
}

func click() {
  post(.leftMouseDown, pos)
  usleep(60_000)
  post(.leftMouseUp, pos)
}

func point(_ i: Int) -> CGPoint {
  CGPoint(x: frame.minX + Double(args[i])!, y: frame.minY + Double(args[i + 1])!)
}

// MARK: Steps

NSApplication.shared.setActivationPolicy(.accessory)
let caption = Caption()

Thread {
  var i = 2
  while i < args.count {
    switch args[i] {
    case "move":
      glide(to: point(i + 1)); i += 3
    case "click":
      glide(to: point(i + 1)); click(); i += 3
    case "cmdclick":
      // Cmd goes down first, so the link cursor shows while hovering.
      caption.show("⌘ Click", for: 2.6)
      setFlags(.maskCommand); usleep(150_000)
      glide(to: point(i + 1)); usleep(400_000)
      click(); usleep(100_000)
      setFlags([]); i += 3
    case "drag":
      glide(to: point(i + 1)); post(.leftMouseDown, pos); usleep(150_000)
      glide(to: point(i + 3), dragging: true, ms: 900); usleep(300_000)
      post(.leftMouseUp, pos); i += 5
    case "toggle":
      caption.show("⌃ ⌘ E", for: 2.4)
      key(14, [.maskControl, .maskCommand]); i += 1
    case "wait":
      usleep(UInt32(Double(args[i + 1])! * 1_000_000)); i += 2
    default:
      fatalError("unknown step \(args[i])")
    }
  }
  usleep(400_000)  // let the last label fade
  DispatchQueue.main.async { exit(0) }
}.start()

NSApplication.shared.run()
