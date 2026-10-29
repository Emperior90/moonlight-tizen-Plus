#pragma once
// The test runner of test_support.h for the C tests of moonlight-common-c (tests/native/*_test.c), with the same output
// in the TAP format:
//   RUN_TEST("name", function) runs a test; CHECK(condition) and CHECK_EQ_INT(actual, expected) record failures.
//   test_summary() prints the totals and returns the exit code (1 if a test failed).
// There are no todo tests here; a known bug of a C file gets its test once it is fixed.

#include <stdbool.h>
#include <stdio.h>

static int test_count = 0;
static int test_failed_count = 0;
static bool test_current_failed = false;

static inline void test_check(bool passed, const char* expression, const char* file, int line) {
  if (!passed) {
    test_current_failed = true;
    printf("  # FAILED %s:%d: %s\n", file, line, expression);
  }
}

static inline void test_check_eq_int(long long actual, long long expected, const char* expression, const char* file,
                                     int line) {
  if (actual != expected) {
    test_current_failed = true;
    printf("  # FAILED %s:%d: %s -> actual %lld, expected %lld\n", file, line, expression, actual, expected);
  }
}

static inline void test_run(const char* name, void (*function)(void)) {
  test_count++;
  test_current_failed = false;
  function();
  if (test_current_failed) {
    test_failed_count++;
  }
  printf("%s %d - %s\n", test_current_failed ? "not ok" : "ok", test_count, name);
  fflush(stdout);
}

static inline int test_summary(void) {
  printf("1..%d\n# tests %d\n# pass %d\n# fail %d\n# todo 0\n", test_count, test_count, test_count - test_failed_count,
         test_failed_count);
  return test_failed_count == 0 ? 0 : 1;
}

#define RUN_TEST(name, function) test_run((name), (function))
#define CHECK(condition) test_check((condition), #condition, __FILE__, __LINE__)
#define CHECK_EQ_INT(actual, expected) \
  test_check_eq_int((long long)(actual), (long long)(expected), #actual " == " #expected, __FILE__, __LINE__)
