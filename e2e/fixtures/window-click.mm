// Deliver mouse events to the fixture window through AppKit's hit test. Posting to
// this process leaves the system pointer and other applications alone.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <initializer_list>

static napi_value click(napi_env env, napi_callback_info info) {
  size_t argc = 3, size = 0;
  napi_value args[3];
  void *bytes = nullptr;
  double x, y;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 3 || napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok ||
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
