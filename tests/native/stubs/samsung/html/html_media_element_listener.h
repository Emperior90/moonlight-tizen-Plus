#pragma once
// Host stand-in for the Samsung HTML media element API (samsung::html), with the listener the app overrides
#include "samsung/html/html_media_element.h"
namespace samsung { namespace html {
enum class MediaError { kMediaErrAborted = 1, kMediaErrNetwork, kMediaErrDecode, kMediaErrSrcNotSupported };
class HTMLMediaElementListener {
 public:
  virtual ~HTMLMediaElementListener() = default;
  virtual void OnError(MediaError, const char*) {}
};
}}
