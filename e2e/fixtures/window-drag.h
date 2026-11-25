#pragma once

#import <AppKit/AppKit.h>
#include <node_api.h>
#include <array>

struct DragWork {
  CGPoint start;
  decltype(&CGEventPost) post;
  decltype(&CGEventCreateMouseEvent) create;
  bool creationFailed;
  napi_deferred released;
  napi_async_work work;
};

static void postDrag(napi_env, void *data) {
  auto *drag = static_cast<DragWork *>(data);
  CGPoint pos = drag->start;
  std::array<CGEventRef, 7> events{};
  for (size_t step = 0; step < events.size(); ++step) {
    CGEventType type = kCGEventLeftMouseDragged;
    if (step == 0) type = kCGEventLeftMouseDown;
    if (step == events.size() - 1) type = kCGEventLeftMouseUp;
    if (type == kCGEventLeftMouseDragged) { pos.x += 8; pos.y += 6; }
    events[step] = drag->create(nullptr, type, pos, kCGMouseButtonLeft);
    if (!events[step]) {
      for (size_t i = 0; i < step; ++i) CFRelease(events[i]);
      drag->creationFailed = true;
      return;
    }
  }
  for (CGEventRef event : events) {
    drag->post(kCGHIDEventTap, event);
    if (event != events.back()) [NSThread sleepForTimeInterval:0.05];
    CFRelease(event);
  }
}

static void finishDrag(napi_env env, napi_status status, void *data) {
  auto *drag = static_cast<DragWork *>(data);
  napi_value result;
  if (status == napi_ok && !drag->creationFailed) {
    napi_get_boolean(env, true, &result);
    napi_resolve_deferred(env, drag->released, result);
  } else {
    napi_value message;
    napi_create_string_utf8(env, drag->creationFailed ? "Could not create native drag event" : "Native drag cancelled", NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &result);
    napi_reject_deferred(env, drag->released, result);
  }
  napi_delete_async_work(env, drag->work);
  delete drag;
}

static napi_value dragWindow(napi_env env, CGPoint start, decltype(&CGEventPost) post,
                             decltype(&CGEventCreateMouseEvent) create = CGEventCreateMouseEvent) {
  auto *drag = new DragWork{start, post, create, false, nullptr, nullptr};
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
