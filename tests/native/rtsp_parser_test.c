// Checks the option list of the RTSP parser of moonlight-common-c (moonlight-common-c/src/RtspParser.c) with the fix of
// upstream commit 5ec8397 ('Fix memory leak if duplicate RTSP options are inserted'): an option that a message carries
// twice replaces the first one and frees what it no longer needs, and an item that is already in the list is left
// alone. The address sanitizer's leak check, which the native tests run with, fails the test on any leak at exit.
// A message that is cut off inside a header is malformed and read only within its buffer: the parser read 1 to 2
// bytes past it before, which the address sanitizer catches.

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
  // Cut off in the value of a header, right after the colon of a header, and after a CR of a header line
  const char* truncated[] = {
    "RTSP/1.0 200 OK\r\nCSeq: 3",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\nSession: DEADBEEFCAFE",
    "RTSP/1.0 200 OK\r\nCSeq:",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r",
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
  // With the double CRLF, with only one (RTSP over ENet), with the second CRLF missing one byte, and with a payload
  const char* complete[] = {
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r\n",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\n",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\n\r",
    "RTSP/1.0 200 OK\r\nCSeq: 3\r\nContent-Length: 4\r\n\r\nv=0\n",
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
  return test_summary();
}
