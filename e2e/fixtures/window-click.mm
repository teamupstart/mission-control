// Clicks use the fixture process queue. WindowServer handles dragging, so the
// optional desktop gesture needs permission to post system pointer events.
#include "window-drag.h"
#include <initializer_list>

static napi_value click(napi_env env, napi_callback_info info) {
  size_t argc = 4, size = 0;
  napi_value args[4];
  void *bytes = nullptr;
  double x, y;
  bool drag = false;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if ((argc != 3 && argc != 4) || (argc == 4 && napi_get_value_bool(env, args[3], &drag) != napi_ok) ||
      napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok ||
      size != sizeof(NSView *) || napi_get_value_double(env, args[1], &x) != napi_ok ||
      napi_get_value_double(env, args[2], &y) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected an Electron window handle and content coordinates");
    return nullptr;
  }
  NSWindow *window = (*(NSView **)bytes).window;
  NSView *content = window.contentView;
  NSPoint point = [content convertPoint:NSMakePoint(x, content.isFlipped ? y : NSHeight(content.bounds) - y)
                                 toView:nil];
  NSView *hit = [content hitTest:[content.superview convertPoint:point fromView:nil]];
  if (drag) {
    // A rendered control at this point means Chromium lost the drag region.
    if (hit) {
      napi_throw_error(env, nullptr, "Blank title bar hit the content view");
      return nullptr;
    }
    bool allowed = CGPreflightPostEventAccess();
    if (allowed) {
      NSPoint screen = [window convertPointToScreen:point];
      if ([NSWindow windowNumberAtPoint:screen belowWindowWithWindowNumber:0] != window.windowNumber) {
        napi_throw_error(env, nullptr, "Another window covers the fixture drag point");
        return nullptr;
      }
      screen.y = NSMaxY(NSScreen.screens.firstObject.frame) - screen.y;
      return dragWindow(env, screen, CGEventPost);
    }
    napi_value posted;
    napi_get_boolean(env, allowed, &posted);
    return posted;
  }
  for (NSEventType type : {NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp}) {
    NSEvent *event = [NSEvent mouseEventWithType:type location:point modifierFlags:0
      timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
      context:nil eventNumber:0 clickCount:1 pressure:type == NSEventTypeLeftMouseDown ? 1 : 0];
    [NSApp postEvent:event atStart:NO];
  }
  napi_value result;
  napi_create_string_utf8(env, hit ? NSStringFromClass(hit.class).UTF8String : "(no content view)", NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "click", NAPI_AUTO_LENGTH, click, nullptr, &function);
  return function;
}
NAPI_MODULE(window_click, init)
