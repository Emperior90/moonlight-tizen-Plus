#pragma once
// Host stand-in for the Samsung HTML media element API (samsung::html), which does nothing
#include <functional>
#include "samsung/wasm/common.h"
namespace samsung { namespace html {
class HTMLMediaElementListener;
class HTMLMediaElement {
 public:
  explicit HTMLMediaElement(const char*) {}
  void SetSrc(samsung::wasm::ElementaryMediaStreamSource*) {}
  void Play(std::function<void(samsung::wasm::OperationResult)>) {}
  samsung::wasm::Result<void> SetListener(HTMLMediaElementListener*) { return {samsung::wasm::OperationResult::kSuccess}; }
};
}}
