// Checks the option list of the RTSP parser of moonlight-common-c (moonlight-common-c/src/RtspParser.c) with the fix of
// upstream commit 5ec8397 ('Fix memory leak if duplicate RTSP options are inserted'): an option that a message carries
// twice replaces the first one and frees what it no longer needs, and an item that is already in the list is left
// alone. The address sanitizer's leak check, which the native tests run with, fails the test on any leak at exit.
// A message that is cut off inside a header is malformed and read only within its buffer: the parser read 1 to 2
// bytes past it before, which the address sanitizer catches.
//
// The parser is the one of upstream commit aeba988 ('Rework RTSP parser to fix many spec compliance issues'), which
// reads line by line instead of with strtok_r() and so replaced the local fix of that over-read (the idea came from
// the fork of samirmartins, 9a85af0). The tests from test_header_names_ignore_case on check what it changed: header
// names in any case, whitespace around a value, line ends of a bare LF, a status line without a reason phrase, strict
// numbers for the status code and the CSeq, header lines without a colon, a middle option inserted again and the
// terminating null of a serialized message. The bytes of every message are parsed from a buffer of their exact size
// (parseExact()), so that the address sanitizer sees any read past them.

#include "test_support_c.h"

#include "../../moonlight-common-c/src/RtspParser.c"

#include <stdlib.h>
#include <string.h>

// Parse a message given as text and return the result code
static int parse(PRTSP_MESSAGE message, const char* text) {
  char* copy = strdup(text);
  int result = parseRtspMessage(message, copy, (int)strlen(copy));
  free(copy);
  return result;
}

static int countOptions(POPTION_ITEM options, const char* name) {
  int count = 0;
  for (POPTION_ITEM item = options; item != NULL; item = item->next) {
    if (strcmp(item->option, name) == 0) {
      count++;
    }
  }
  return count;
}

static void test_duplicate_header_keeps_the_last_value(void) {
  RTSP_MESSAGE message;
  int result = parse(&message,
                     "RTSP/1.0 200 OK\r\n"
                     "CSeq: 3\r\n"
                     "Session: DEADBEEFCAFE;timeout = 90\r\n"
                     "Session: 0123456789AB;timeout = 90\r\n"
                     "\r\n");
  CHECK_EQ_INT(result, RTSP_ERROR_SUCCESS);
  if (result != RTSP_ERROR_SUCCESS) {
    return;
  }
  CHECK_EQ_INT(message.sequenceNumber, 3);
  CHECK_EQ_INT(message.message.response.statusCode, 200);
  CHECK_EQ_INT(countOptions(message.options, "Session"), 1);
  CHECK(strcmp(getOptionContent(message.options, "Session"), "0123456789AB;timeout = 90") == 0);
  freeMessage(&message);
}

// Options that own their texts (FLAG_ALLOCATED_OPTION_FIELDS), as RtspConnection.c builds them for its requests
static POPTION_ITEM allocatedOption(const char* name, const char* content) {
  POPTION_ITEM item = (POPTION_ITEM)malloc(sizeof(OPTION_ITEM));
  item->flags = FLAG_ALLOCATED_OPTION_FIELDS;
  item->option = strdup(name);
  item->content = strdup(content);
  item->next = NULL;
  return item;
}

static void test_duplicate_allocated_option_frees_the_replaced_texts(void) {
  POPTION_ITEM options = NULL;
  insertOption(&options, allocatedOption("CSeq", "1"));
  insertOption(&options, allocatedOption("X-GS-ClientVersion", "14"));
  insertOption(&options, allocatedOption("CSeq", "2"));
  CHECK_EQ_INT(countOptions(options, "CSeq"), 1);
  CHECK_EQ_INT(countOptions(options, "X-GS-ClientVersion"), 1);
  CHECK(strcmp(getOptionContent(options, "CSeq"), "2") == 0);
  // The replacement takes over the place of the first option
  CHECK(strcmp(options->option, "CSeq") == 0);
  freeOptionList(options);
}

static void test_inserting_the_last_item_again_changes_nothing(void) {
  POPTION_ITEM options = NULL;
  POPTION_ITEM first = allocatedOption("CSeq", "1");
  POPTION_ITEM last = allocatedOption("Session", "DEADBEEFCAFE");
  insertOption(&options, first);
  insertOption(&options, last);
  insertOption(&options, last);
  CHECK(options == first);
  CHECK(first->next == last);
  CHECK(last->next == NULL);
  CHECK(strcmp(getOptionContent(options, "Session"), "DEADBEEFCAFE") == 0);
  freeOptionList(options);
}

static void test_duplicate_header_of_a_request(void) {
  RTSP_MESSAGE message;
  int result = parse(&message,
                     "OPTIONS rtsp://10.0.0.2:48010 RTSP/1.0\r\n"
                     "CSeq: 1\r\n"
                     "CSeq: 2\r\n"
                     "\r\n");
  CHECK_EQ_INT(result, RTSP_ERROR_SUCCESS);
  if (result != RTSP_ERROR_SUCCESS) {
    return;
  }
  CHECK_EQ_INT(message.type, TYPE_REQUEST);
  CHECK_EQ_INT(message.sequenceNumber, 2);
  CHECK_EQ_INT(countOptions(message.options, "CSeq"), 1);
  freeMessage(&message);
}

// Parse exactly the given bytes, from a buffer of that size, so that the address sanitizer sees any read past them
static int parseExact(PRTSP_MESSAGE message, const char* text) {
  size_t length = strlen(text);
  char* copy = malloc(length);
  memcpy(copy, text, length);
  int result = parseRtspMessage(message, copy, (int)length);
  free(copy);
  return result;
}

static void test_truncated_message_is_malformed(void) {
  // Cut off in the value of a header, right after the colon of a header, and in the status line
  const char* truncated[] = {
    "RTSP/1.0 200 OK\r\nCSeq: 3",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\nSession: DEADBEEFCAFE",
    "RTSP/1.0 200 OK\r\nCSeq:",
    "RTSP/1.0 200 OK",
    "RTSP/1.0 200",
  };
  for (size_t i = 0; i < sizeof(truncated) / sizeof(truncated[0]); i++) {
    RTSP_MESSAGE message;
    int result = parseExact(&message, truncated[i]);
    CHECK_EQ_INT(result, RTSP_ERROR_MALFORMED);
    if (result == RTSP_ERROR_SUCCESS) {
      freeMessage(&message);
    }
  }
}

static void test_complete_messages_still_parse(void) {
  // With the double CRLF, with only one (RTSP over ENet), with the second CRLF missing one byte, with a payload, and
  // with only the CR of the last line: since aeba988 a line that ends at the end of the buffer counts as the end of
  // the message like the missing CRLF of RTSP over ENet (the parser before it read 1 to 2 bytes past such a message
  // and took it as malformed)
  const char* complete[] = {
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r\n",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\n",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\nContent-Length: 4\r\n\r\nv=0\n",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r",
  };
  for (size_t i = 0; i < sizeof(complete) / sizeof(complete[0]); i++) {
    RTSP_MESSAGE message;
    int result = parseExact(&message, complete[i]);
    CHECK_EQ_INT(result, RTSP_ERROR_SUCCESS);
    if (result != RTSP_ERROR_SUCCESS) {
      continue;
    }
    CHECK_EQ_INT(message.sequenceNumber, 3);
    if (i == 3) {
      CHECK_EQ_INT(message.payloadLength, 4);
      CHECK(memcmp(message.payload, "v=0\n", 4) == 0);
    }
    freeMessage(&message);
  }
}

// Parse a message that must be valid; returns false (with a failed check) if it isn't
static bool parseValid(PRTSP_MESSAGE message, const char* text) {
  int result = parseExact(message, text);
  CHECK_EQ_INT(result, RTSP_ERROR_SUCCESS);
  return result == RTSP_ERROR_SUCCESS;
}

static void test_header_names_ignore_case(void) {
  RTSP_MESSAGE message;
  if (!parseValid(&message, "RTSP/1.0 200 OK\r\ncseq: 5\r\nSESSION: DEADBEEFCAFE;timeout = 90\r\n\r\n")) {
    return;
  }
  CHECK_EQ_INT(message.sequenceNumber, 5);
  CHECK(getOptionContent(message.options, "Session") != NULL &&
        strcmp(getOptionContent(message.options, "Session"), "DEADBEEFCAFE;timeout = 90") == 0);
  freeMessage(&message);

  // A header that comes twice in different case is the same header
  if (!parseValid(&message, "RTSP/1.0 200 OK\r\nCSeq: 1\r\ncseq: 2\r\n\r\n")) {
    return;
  }
  CHECK_EQ_INT(message.sequenceNumber, 2);
  CHECK_EQ_INT(countOptions(message.options, "CSeq") + countOptions(message.options, "cseq"), 1);
  freeMessage(&message);
}

static void test_whitespace_around_a_value_is_trimmed(void) {
  RTSP_MESSAGE message;
  // No space after the colon (the parser before aeba988 dropped the first character of the value), several spaces and
  // tabs around it, a colon inside the value and an empty value
  if (!parseValid(&message,
                  "RTSP/1.0 200 OK\r\n"
                  "CSeq:4\r\n"
                  "Session:  \tDEADBEEFCAFE \t\r\n"
                  "Transport: server_port=48000;x=1:2\r\n"
                  "X-Empty:\r\n"
                  "\r\n")) {
    return;
  }
  CHECK_EQ_INT(message.sequenceNumber, 4);
  CHECK(strcmp(getOptionContent(message.options, "Session"), "DEADBEEFCAFE") == 0);
  CHECK(strcmp(getOptionContent(message.options, "Transport"), "server_port=48000;x=1:2") == 0);
  CHECK(getOptionContent(message.options, "X-Empty") != NULL &&
        strcmp(getOptionContent(message.options, "X-Empty"), "") == 0);
  freeMessage(&message);
}

static void test_lines_may_end_with_a_bare_lf(void) {
  RTSP_MESSAGE message;
  if (!parseValid(&message, "RTSP/1.0 200 OK\nCSeq: 3\nContent-Length: 4\n\nv=0\n")) {
    return;
  }
  CHECK_EQ_INT(message.sequenceNumber, 3);
  CHECK_EQ_INT(message.payloadLength, 4);
  CHECK(message.payload != NULL && memcmp(message.payload, "v=0\n", 4) == 0);
  freeMessage(&message);
}

static void test_status_line_without_reason_phrase(void) {
  RTSP_MESSAGE message;
  // The parser before aeba988 took the next line as the reason phrase and lost the CSeq
  if (!parseValid(&message, "RTSP/1.0 200\r\nCSeq: 3\r\n\r\n")) {
    return;
  }
  CHECK_EQ_INT(message.message.response.statusCode, 200);
  CHECK(strcmp(message.message.response.statusString, "") == 0);
  CHECK_EQ_INT(message.sequenceNumber, 3);
  freeMessage(&message);
}

static void test_status_code_must_be_a_positive_number(void) {
  // atoi() of the parser before aeba988 made status 0 of these, or a wrapped number of the last one
  const char* invalid[] = {
    "RTSP/1.0 abc OK\r\nCSeq: 3\r\n\r\n",
    "RTSP/1.0 0 OK\r\nCSeq: 3\r\n\r\n",
    "RTSP/1.0 -200 OK\r\nCSeq: 3\r\n\r\n",
    "RTSP/1.0 200x OK\r\nCSeq: 3\r\n\r\n",
    "RTSP/1.0 99999999999999999999 OK\r\nCSeq: 3\r\n\r\n",
  };
  for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
    RTSP_MESSAGE message;
    int result = parseExact(&message, invalid[i]);
    CHECK_EQ_INT(result, RTSP_ERROR_MALFORMED);
    if (result == RTSP_ERROR_SUCCESS) {
      freeMessage(&message);
    }
  }
}

static void test_cseq_must_be_a_whole_number(void) {
  // atoi() of the parser before aeba988 made 0, 12, -1 and a wrapped number of these
  const char* invalid[] = {
    "RTSP/1.0 200 OK\r\nCSeq: abc\r\n\r\n",
    "RTSP/1.0 200 OK\r\nCSeq: 12abc\r\n\r\n",
    "RTSP/1.0 200 OK\r\nCSeq: -1\r\n\r\n",
    "RTSP/1.0 200 OK\r\nCSeq: 99999999999999999999\r\n\r\n",
  };
  for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
    RTSP_MESSAGE message;
    if (!parseValid(&message, invalid[i])) {
      continue;
    }
    CHECK_EQ_INT(message.sequenceNumber, SEQ_INVALID);
    freeMessage(&message);
  }
}

static void test_malformed_lines_are_refused(void) {
  const char* malformed[] = {
    // A header line without a colon, which the parser before aeba988 took as the name of a header whose value was
    // the next line
    "RTSP/1.0 200 OK\r\nGarbage\r\nCSeq: 3\r\n\r\n",
    "RTSP/1.0 200 OK\r\n: value\r\n\r\n",                 // a header without a name
    "RTSP/2.0 200 OK\r\nCSeq: 3\r\n\r\n",                  // another protocol
    "OPTIONS rtsp://10.0.0.2:48010\r\nCSeq: 1\r\n\r\n",  // a request without a protocol
  };
  for (size_t i = 0; i < sizeof(malformed) / sizeof(malformed[0]); i++) {
    RTSP_MESSAGE message;
    int result = parseExact(&message, malformed[i]);
    CHECK_EQ_INT(result, RTSP_ERROR_MALFORMED);
    if (result == RTSP_ERROR_SUCCESS) {
      freeMessage(&message);
    }
  }
  // A message of no bytes
  RTSP_MESSAGE message;
  char empty[1] = { 0 };
  CHECK_EQ_INT(parseRtspMessage(&message, empty, 0), RTSP_ERROR_MALFORMED);
}

static void test_inserting_a_middle_item_again_keeps_the_list(void) {
  // The parser before aeba988 cleared the link of the item first, which cut off (and leaked) the rest of the list
  POPTION_ITEM options = NULL;
  POPTION_ITEM first = allocatedOption("CSeq", "1");
  POPTION_ITEM middle = allocatedOption("Session", "DEADBEEFCAFE");
  POPTION_ITEM last = allocatedOption("Transport", "server_port=48000");
  insertOption(&options, first);
  insertOption(&options, middle);
  insertOption(&options, last);
  insertOption(&options, middle);
  CHECK(options == first);
  CHECK(first->next == middle);
  CHECK(middle->next == last);
  CHECK(last->next == NULL);
  freeOptionList(options);
}

static void test_serialized_message_ends_with_a_null(void) {
  // A request with a payload, which is copied in last, without the null that the texts before it got
  char payload[] = "v=0";
  POPTION_ITEM options = NULL;
  insertOption(&options, allocatedOption("CSeq", "2"));
  RTSP_MESSAGE request;
  createRtspRequest(&request, NULL, FLAG_ALLOCATED_OPTION_ITEMS, "ANNOUNCE", "streamid=control/13/0", "RTSP/1.0", 2,
                    options, payload, 3);
  int length = 0;
  char* serialized = serializeRtspMessage(&request, &length);
  CHECK(serialized != NULL);
  if (serialized != NULL) {
    const char* expected = "ANNOUNCE streamid=control/13/0 RTSP/1.0\r\nCSeq: 2\r\n\r\nv=0";
    CHECK_EQ_INT(length, (int)strlen(expected));
    CHECK(memcmp(serialized, expected, strlen(expected)) == 0);
    CHECK_EQ_INT(serialized[length], '\0');
    free(serialized);
  }
  freeMessage(&request);
}

int main(void) {
  RUN_TEST("a header that a response carries twice keeps its last value without a leak (upstream 5ec8397)",
           test_duplicate_header_keeps_the_last_value);
  RUN_TEST("a duplicate option that owns its texts frees the replaced ones (upstream 5ec8397)",
           test_duplicate_allocated_option_frees_the_replaced_texts);
  RUN_TEST("inserting the last option of the list again leaves the list as it is (upstream 5ec8397)",
           test_inserting_the_last_item_again_changes_nothing);
  RUN_TEST("a header that a request carries twice keeps its last value without a leak (upstream 5ec8397)",
           test_duplicate_header_of_a_request);
  RUN_TEST("a message cut off inside a header is malformed and read only within its buffer",
           test_truncated_message_is_malformed);
  RUN_TEST("complete messages still parse, also without the second CRLF of RTSP over ENet",
           test_complete_messages_still_parse);
  RUN_TEST("header names are matched in any case (upstream aeba988)", test_header_names_ignore_case);
  RUN_TEST("whitespace around a header value is trimmed, a colon inside it kept (upstream aeba988)",
           test_whitespace_around_a_value_is_trimmed);
  RUN_TEST("lines may end with a bare LF, also before the payload (upstream aeba988)", test_lines_may_end_with_a_bare_lf);
  RUN_TEST("a status line without a reason phrase keeps the headers after it (upstream aeba988)",
           test_status_line_without_reason_phrase);
  RUN_TEST("a status code that isn't a positive number is malformed (upstream aeba988)",
           test_status_code_must_be_a_positive_number);
  RUN_TEST("a CSeq that isn't a whole number is no sequence number (upstream aeba988)",
           test_cseq_must_be_a_whole_number);
  RUN_TEST("header lines without a colon or a name, another protocol and an empty message are malformed "
           "(upstream aeba988)",
           test_malformed_lines_are_refused);
  RUN_TEST("inserting an option from the middle of the list again keeps the list (upstream aeba988)",
           test_inserting_a_middle_item_again_keeps_the_list);
  RUN_TEST("a serialized message with a payload ends with a null (upstream aeba988)",
           test_serialized_message_ends_with_a_null);
  return test_summary();
}
