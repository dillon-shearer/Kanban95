import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count == 6, let line = readLine(), let url = URL(string: line), let width = Double(args[1]), let height = Double(args[2]), let zoom = Double(args[3]) else {
  FileHandle.standardError.write("usage: shot-mac <width> <height> <zoom> <board|start|switch|taskmenu> <out.png>, with the url on stdin\n".data(using: .utf8)!)
  exit(2)
}
let open = args[4]
let out = URL(fileURLWithPath: args[5])

func fail(_ message: String) -> Never {
  FileHandle.standardError.write("shot-mac: \(message)\n".data(using: .utf8)!)
  exit(1)
}

let page = """
const wait = async (sel, n = 0) => {
  for (let i = 0; i < 400; i++) {
    const el = document.querySelectorAll(sel)[n];
    if (el) return el;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${sel}`);
};
const probe = document.createElement('div');
probe.style.cssText = 'position:absolute;width:100px;height:1px;zoom:2;visibility:hidden';
document.documentElement.append(probe);
const screenRects = probe.getBoundingClientRect().width === 200;
probe.remove();
const press = (el, type, button) => {
  const r = el.getBoundingClientRect();
  const f = screenRects ? 1 : zoom;
  const at = { bubbles: true, cancelable: true, view: window, button, clientX: (r.left + r.width / 2) * f, clientY: (r.top + r.height / 2) * f };
  for (const t of button ? ['mousedown', 'mouseup', type] : ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, at));
};
await wait('.k95-board .card');
await wait('#tasks .task', 2);
if (open === 'start') press(await wait('#start'), 'click', 0);
if (open === 'switch') press(await wait('#switch'), 'click', 0);
if (open === 'taskmenu') press(await wait('[data-task="board"]'), 'contextmenu', 2);
if (open === 'start' || open === 'taskmenu') await wait('.k95-menu');
if (open === 'switch') await wait('.k95-switch');
await new Promise((r) => setTimeout(r, 300));
"""

class Shot: NSObject, WKNavigationDelegate {
  let pageArgs: [String: Any]
  init(_ pageArgs: [String: Any]) { self.pageArgs = pageArgs }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.callAsyncJavaScript(page, arguments: pageArgs, in: nil, in: .page) { result in
      if case .failure(let e) = result { fail("page: \(e)") }
      webView.takeSnapshot(with: nil) { image, error in
        guard let image, let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
          fail("snapshot: \(error.map { "\($0)" } ?? "no image")")
        }
        do { try png.write(to: out) } catch { fail("write: \(error)") }
        exit(0)
      }
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("load: \(error)") }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("load: \(error)") }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let frame = NSRect(x: -20000, y: -20000, width: width, height: height)
let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
let setEnabled = NSSelectorFromString("_setEnabled:forFeature:")
typealias SetEnabled = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
for feature in (WKPreferences.self as AnyObject).perform(NSSelectorFromString("_features"))?.takeUnretainedValue() as? [NSObject] ?? []
where feature.value(forKey: "key") as? String == "AsyncOverflowScrollingEnabled" {
  unsafeBitCast(config.preferences.method(for: setEnabled), to: SetEnabled.self)(config.preferences, setEnabled, false, feature)
}
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
window.contentView = view
let shot = Shot(["open": open, "zoom": zoom])
view.navigationDelegate = shot
view.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 60) { fail("timed out after 60 s") }
app.run()
