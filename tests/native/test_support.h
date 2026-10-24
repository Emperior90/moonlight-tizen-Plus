#pragma once
// A very small test runner for the native tests, with output in the TAP format that node:test prints too:
//   RunTest("name", function) runs a test; CHECK(condition) and CHECK_EQ(actual, expected) record failures.
//   RunTodoTest("name", "reason", function) runs a test for a known bug: its failed checks are reported as TODO and
//   don't fail the run, so the test turns into a regular one once the bug is fixed (like { todo } in node:test).
//   Summary() prints the totals and returns the exit code (1 if a regular test failed).

#include <cstdio>
#include <sstream>
#include <string>

namespace test_support {

struct State {
  int tests = 0;
  int failedTests = 0;
  int todoTests = 0;
  bool currentFailed = false;
  bool currentIsTodo = false;
};

inline State& state() {
  static State instance;
  return instance;
}

// Record the result of one check and print the details of a failure
inline void Check(bool passed, const std::string& expression, const std::string& details, const char* file, int line) {
  if (passed) {
    return;
  }
  state().currentFailed = true;
  std::printf("  # %s %s:%d: %s%s%s\n", state().currentIsTodo ? "todo failure" : "FAILED", file, line, expression.c_str(),
              details.empty() ? "" : " -> ", details.c_str());
}

template <typename A, typename B>
std::string DescribeValues(const A& actual, const B& expected) {
  std::ostringstream out;
  out << "actual " << actual << ", expected " << expected;
  return out.str();
}

inline void RunTestImpl(const char* name, void (*function)(), const char* todoReason) {
  State& s = state();
  s.tests++;
  s.currentFailed = false;
  s.currentIsTodo = todoReason != nullptr;
  function();
  if (todoReason) {
    s.todoTests++;
    std::printf("%s %d - %s # TODO %s\n", s.currentFailed ? "not ok" : "ok", s.tests, name, todoReason);
  } else {
    if (s.currentFailed) {
      s.failedTests++;
    }
    std::printf("%s %d - %s\n", s.currentFailed ? "not ok" : "ok", s.tests, name);
  }
  std::fflush(stdout);
}

inline void RunTest(const char* name, void (*function)()) {
  RunTestImpl(name, function, nullptr);
}

inline void RunTodoTest(const char* name, const char* reason, void (*function)()) {
  RunTestImpl(name, function, reason);
}

inline int Summary() {
  const State& s = state();
  std::printf("1..%d\n# tests %d\n# pass %d\n# fail %d\n# todo %d\n", s.tests, s.tests, s.tests - s.failedTests - s.todoTests,
              s.failedTests, s.todoTests);
  return s.failedTests == 0 ? 0 : 1;
}

}  // namespace test_support

#define CHECK(condition) test_support::Check((condition), #condition, "", __FILE__, __LINE__)
#define CHECK_EQ(actual, expected) \
  test_support::Check((actual) == (expected), #actual " == " #expected, test_support::DescribeValues((actual), (expected)), __FILE__, __LINE__)
