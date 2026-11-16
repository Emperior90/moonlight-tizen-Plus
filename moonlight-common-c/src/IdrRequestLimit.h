#pragma once

// Moonlight Plus: the rule that limits the IDR frame requests while an IDR frame is already on its way. This is a
// change of Moonlight Plus to the vendored library, not part of upstream moonlight-common-c.
//
// Every LiRequestIdrFrame() used to send a request to the host: the depacketizer asks again for the first complete
// frame after each loss and for every corrupt frame while it waits for the IDR frame, and every frame that the video
// player of the TV rejects asks once more. Sunshine encodes a keyframe for each request it gets, so requests a frame
// apart bring one large keyframe each, which costs bitrate and causes more loss on a weak link (moonlight-tv issue
// #639: about 30 requests per second in episodes, the send rate of the host up from 45 to 60-87 Mbps).
//
// The rule: a request is sent at once, unless a request sent less than a window ago is still waiting for its IDR
// frame. Then it is held: the IDR frame on its way answers it, and an IDR frame that arrives ends the hold at once.
// When the window ends and a held request is still unanswered (the IDR frame was lost), one request is sent for all
// of them, which starts the next window. An IDR frame answers every request made before it arrived, sent or not.
// The window is twice the round trip time to the host plus two frame intervals, which covers the way of the request
// to the host, the frame the host is encoding and the way of the keyframe back, clamped to 50 to 250 ms. With an
// unknown round trip time it is the longest window: a window that is too short asks again before the keyframe can
// arrive, which is the storm of requests this rule prevents, while one that is too long only delays the request for
// a lost keyframe by at most 250 ms. A large keyframe can take longer than that estimate to arrive, e.g. on Wi-Fi at
// a high bitrate, where it is sent for 10 to 40 ms after the host encoded it; so the window is also at least a quarter
// longer than the last IDR frame took to arrive, within the same bounds. That time runs from the first request sent
// since the IDR frame before, so that a request sent once more at the end of a window, just before the slow keyframe
// arrives, doesn't hide it; after a lost keyframe it comes out too long, which only lengthens the next window.
//
// The functions only change the state they are given and take the time as an argument, so that the native test
// (tests/native/idr_request_limit_test.c) drives them on its own. ControlStream.c keeps the state of a stream under a
// mutex: LiRequestIdrFrame() calls IdrLimitOnRequest(), the depacketizer IdrLimitOnIdrFrame() through
// connectionReceivedIdrFrame(), and the IDR request thread IdrLimitNext().

#include <stdbool.h>
#include <stdint.h>

#define IDR_LIMIT_MIN_WINDOW_MS 50
#define IDR_LIMIT_MAX_WINDOW_MS 250
// An IDR frame that comes later than this after the first request since the IDR frame before doesn't count as its
// answer: the host may have sent it for another reason, e.g. a restart of its encoder
#define IDR_LIMIT_MAX_ANSWER_MS 1000

typedef struct _IDR_REQUEST_LIMIT {
    // A request that is neither sent nor answered by an IDR frame yet
    bool pending;
    // A request was sent and no IDR frame arrived since: until holdEndMs, later requests are held
    bool holding;
    uint64_t holdEndMs;
    // The requests of the stream that were sent to the host, and those that came while an earlier request was
    // waiting for its IDR frame in its window, so they were not sent at once (one of them may be sent when the
    // window ends)
    uint32_t sent;
    uint32_t held;
    // When the first request since the last IDR frame was sent, how long the last IDR frame took to arrive after it
    // (0 before the first), and the longest of these times in the stream
    uint64_t firstSentMs;
    uint32_t answerMs;
    uint32_t slowestAnswerMs;
} IDR_REQUEST_LIMIT, *PIDR_REQUEST_LIMIT;

// The state at the start of a stream: nothing sent, nothing held
static inline void IdrLimitReset(PIDR_REQUEST_LIMIT limit) {
    limit->pending = false;
    limit->holding = false;
    limit->holdEndMs = 0;
    limit->sent = 0;
    limit->held = 0;
    limit->firstSentMs = 0;
    limit->answerMs = 0;
    limit->slowestAnswerMs = 0;
}

// The window of a request in milliseconds: twice the round trip time plus two frame intervals of the stream, clamped.
// Without a known round trip time or frame rate it is the longest window.
static inline uint32_t IdrLimitWindowMs(bool rttKnown, uint32_t rttMs, int fps) {
    uint64_t windowMs;

    if (!rttKnown || fps <= 0) {
        return IDR_LIMIT_MAX_WINDOW_MS;
    }

    // Two frame intervals, rounded up
    windowMs = 2 * (uint64_t)rttMs + (2000 + (uint64_t)fps - 1) / (uint64_t)fps;
    if (windowMs < IDR_LIMIT_MIN_WINDOW_MS) {
        return IDR_LIMIT_MIN_WINDOW_MS;
    }
    if (windowMs > IDR_LIMIT_MAX_WINDOW_MS) {
        return IDR_LIMIT_MAX_WINDOW_MS;
    }
    return (uint32_t)windowMs;
}

// A request for an IDR frame at nowMs. Returns whether it is held, i.e. not sent at once.
static inline bool IdrLimitOnRequest(PIDR_REQUEST_LIMIT limit, uint64_t nowMs) {
    bool held = limit->holding && nowMs < limit->holdEndMs;

    if (held) {
        limit->held++;
    }
    limit->pending = true;
    return held;
}

// The window of a request sent now: the window of windowMs, or a quarter longer than the last IDR frame took to
// arrive if that is longer, at most the longest window
static inline uint32_t IdrLimitAnsweredWindowMs(PIDR_REQUEST_LIMIT limit, uint32_t windowMs) {
    uint32_t answeredMs = limit->answerMs + limit->answerMs / 4;

    if (answeredMs > windowMs) {
        windowMs = answeredMs;
    }
    return windowMs < IDR_LIMIT_MAX_WINDOW_MS ? windowMs : IDR_LIMIT_MAX_WINDOW_MS;
}

// An IDR frame arrived at nowMs: it answers every request before it, and ends the hold. If a request was sent since
// the last IDR frame, the time since the first of them is how long the host took to answer.
static inline void IdrLimitOnIdrFrame(PIDR_REQUEST_LIMIT limit, uint64_t nowMs) {
    if (limit->holding && nowMs >= limit->firstSentMs && nowMs - limit->firstSentMs <= IDR_LIMIT_MAX_ANSWER_MS) {
        limit->answerMs = (uint32_t)(nowMs - limit->firstSentMs);
        if (limit->answerMs > limit->slowestAnswerMs) {
            limit->slowestAnswerMs = limit->answerMs;
        }
    }
    limit->pending = false;
    limit->holding = false;
}

// What the IDR request thread does at nowMs. Returns true when it sends a request now, which starts a window of
// windowMs, or longer after a slow answer (IdrLimitAnsweredWindowMs()). Otherwise it waits for the next request, or
// with *waitMs above 0 at most that long, until the hold of a held request ends.
static inline bool IdrLimitNext(PIDR_REQUEST_LIMIT limit, uint64_t nowMs, uint32_t windowMs, uint32_t* waitMs) {
    *waitMs = 0;

    if (!limit->pending) {
        return false;
    }

    if (limit->holding && nowMs < limit->holdEndMs) {
        *waitMs = (uint32_t)(limit->holdEndMs - nowMs);
        return false;
    }

    // The first request since the last IDR frame, or since one too long ago to be answered by it, starts the time of
    // the answer
    if (!limit->holding || nowMs - limit->firstSentMs > IDR_LIMIT_MAX_ANSWER_MS) {
        limit->firstSentMs = nowMs;
    }
    limit->pending = false;
    limit->holding = true;
    limit->holdEndMs = nowMs + IdrLimitAnsweredWindowMs(limit, windowMs);
    limit->sent++;
    return true;
}
