#include "../../e2e/fixtures/window-drag.h"
#include <atomic>

static std::atomic<CGEventType> lastPosted{kCGEventNull};

static void recordPost(CGEventTapLocation, CGEventRef event) {
  lastPosted.store(CGEventGetType(event));
}

static napi_value start(napi_env env, napi_callback_info) {
  return dragWindow(env, CGPointZero, recordPost);
}

static napi_value released(napi_env env, napi_callback_info) {
  napi_value value;
  napi_get_boolean(env, lastPosted.load() == kCGEventLeftMouseUp, &value);
  return value;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"released", nullptr, released, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, methods);
  return exports;
}
