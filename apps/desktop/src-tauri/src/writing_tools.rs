//! Keeps macOS Writing Tools out of our webviews. Their editable fields are terminals' hidden
//! inputs, and WebKit's per-element opt-out (`writingsuggestions`, set in `terminals.ts`) hides
//! only inline predictions. Writing Tools themselves follow the webview's configuration, which
//! WebKit copies when the webview is created, so it has to be set before then.
//!
//! The configuration doesn't hide the affordance (the Apple Intelligence icon at the caret):
//! `WKWebView` still answers `allowsWritingToolsAffordance` with YES for a focused text field,
//! and xterm keeps its hidden input at the terminal cursor. [`hide_affordance`] overrides that.
#![allow(unsafe_code)]

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, Imp, NSObjectProtocol, Sel};
use objc2::{Encode, MainThreadMarker, msg_send, sel};
use objc2_web_kit::WKWebViewConfiguration;

/// `NSWritingToolsBehaviorNone`.
const BEHAVIOR_NONE: isize = -1;

/// A webview configuration with Writing Tools off, or `None` off the main thread.
pub fn configuration() -> Option<Retained<WKWebViewConfiguration>> {
    let mtm = MainThreadMarker::new()?;
    // SAFETY: plain allocation of a configuration on the main thread.
    let config = unsafe { WKWebViewConfiguration::new(mtm) };
    // `writingToolsBehavior` exists from macOS 15; older systems have no Writing Tools.
    if config.respondsToSelector(sel!(setWritingToolsBehavior:)) {
        // SAFETY: the selector exists and takes an `NSWritingToolsBehavior` (an `NSInteger`).
        let () = unsafe { msg_send![&*config, setWritingToolsBehavior: BEHAVIOR_NONE] };
    }
    Some(config)
}

/// Applies [`configuration`] to a window about to be built.
pub fn disable<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    match configuration() {
        Some(config) => builder.with_webview_configuration(config),
        None => builder,
    }
}

extern "C-unwind" fn disallow(_: &AnyObject, _: Sel) -> Bool {
    Bool::NO
}

/// Makes the window's webview class answer `allowsWritingToolsAffordance` with NO. The method
/// is added to wry's `WKWebView` subclass once; later calls are no-ops.
pub fn hide_affordance<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.with_webview(|webview| {
        // SAFETY: on macOS `inner` is the live `WKWebView` (a wry subclass), and the closure
        // runs on the main thread while the webview exists.
        let Some(view) = (unsafe { webview.inner().cast::<AnyObject>().as_ref() }) else {
            return;
        };
        let class = view.class();
        // SAFETY: the function matches the platform BOOL encoding, followed by `self`, `_cmd`;
        // `Imp` is the untyped form the runtime stores, cast back by `objc_msgSend` callers.
        let imp = unsafe {
            std::mem::transmute::<extern "C-unwind" fn(&AnyObject, Sel) -> Bool, Imp>(disallow)
        };
        // SAFETY: adding a method to a registered class; `class_addMethod` refuses (returns NO)
        // if the class already defines it, so repeated calls change nothing.
        let encoding = std::ffi::CString::new(format!("{}@:", Bool::ENCODING)).unwrap();
        unsafe {
            objc2::ffi::class_addMethod(
                std::ptr::from_ref(class).cast_mut(),
                sel!(allowsWritingToolsAffordance),
                imp,
                encoding.as_ptr(),
            );
        }
    });
}
