#pragma once

#import <AppKit/AppKit.h>
#include <node_api.h>

struct DragWork {
  CGPoint start;
  decltype(&CGEventPost) post;
  napi_deferred released;
  napi_async_work work;
};

static void postDrag(napi_env, void *data) {
  auto *drag = static_cast<DragWork *>(data);
  CGPoint pos = drag->start;
  for (int step = 0; step <= 6; ++step) {
    CGEventType type = kCGEventLeftMouseDragged;
    if (step == 0) type = kCGEventLeftMouseDown;
    if (step == 6) type = kCGEventLeftMouseUp;
    if (type == kCGEventLeftMouseDragged) { pos.x += 8; pos.y += 6; }
    CGEventRef event = CGEventCreateMouseEvent(nullptr, type, pos, kCGMouseButtonLeft);
    drag->post(kCGHIDEventTap, event);
    CFRelease(event);
    if (type != kCGEventLeftMouseUp) [NSThread sleepForTimeInterval:0.05];
  }
}

static void finishDrag(napi_env env, napi_status status, void *data) {
  auto *drag = static_cast<DragWork *>(data);
  napi_value result;
  if (status == napi_ok) {
    napi_get_boolean(env, true, &result);
    napi_resolve_deferred(env, drag->released, result);
  } else {
    napi_create_string_utf8(env, "Native drag cancelled", NAPI_AUTO_LENGTH, &result);
    napi_reject_deferred(env, drag->released, result);
  }
  napi_delete_async_work(env, drag->work);
  delete drag;
}

static napi_value dragWindow(napi_env env, CGPoint start, decltype(&CGEventPost) post) {
  auto *drag = new DragWork{start, post, nullptr, nullptr};
  napi_value name, promise;
  if (napi_create_promise(env, &drag->released, &promise) != napi_ok ||
      napi_create_string_utf8(env, "postWindowDrag", NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_create_async_work(env, nullptr, name, postDrag, finishDrag, drag, &drag->work) != napi_ok ||
      napi_queue_async_work(env, drag->work) != napi_ok) {
    if (drag->work) napi_delete_async_work(env, drag->work);
    delete drag;
    napi_throw_error(env, nullptr, "Could not start native drag");
    return nullptr;
  }
  return promise;
}
