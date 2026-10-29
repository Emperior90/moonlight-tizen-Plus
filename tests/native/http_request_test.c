// Checks http_request() of libgamestream/http.c with a simulated curl that hands it a prepared answer in chunks, like
// libcurl does: an answer larger than the limit of HTTP_DATA (HTTP_MAX_RESPONSE_SIZE, 4 MiB, or 16 MiB for box art)
// fails with GS_RESPONSE_TOO_LARGE without the buffer growing past the limit, the next request on the same buffer
// works again, and the log line of a request leaves out its query, which holds the remote input key of a launch
// (rikey) and the secrets of the pairing. The curl functions below replace libcurl, so no network is needed.
//
// Build with: -lssl -lcrypto

// The type checks of curl.h wrap curl_easy_setopt() in a macro, which the simulated one below can't be defined with
#define CURL_DISABLE_TYPECHECK
// http.c still uses CURLOPT_PROGRESSFUNCTION, which the curl of the TV build has, but newer headers mark deprecated
#define CURL_DISABLE_DEPRECATION
#define OPENSSL_SUPPRESS_DEPRECATED

#include "test_support_c.h"

// What http.c needs (run.sh skips this test without these headers)
#include <curl/curl.h>
#include <openssl/ssl.h>

#include "../../libgamestream/http.c"

#include <stdarg.h>
#include <unistd.h>

X509* g_Cert;
EVP_PKEY* g_PrivateKey;

// The simulated transfer: the answer that curl_easy_perform() delivers, and what the request set
static struct {
  const char* answer;
  size_t answerSize;
  size_t largestBuffer;
  curl_write_callback write;
  void* writeData;
  char url[1024];
} transfer;

static int curlHandle;

CURL* curl_easy_init(void) {
  return &curlHandle;
}

CURLcode curl_easy_setopt(CURL* curl, CURLoption option, ...) {
  (void)curl;
  va_list args;
  va_start(args, option);
  if (option == CURLOPT_WRITEFUNCTION) {
    transfer.write = va_arg(args, curl_write_callback);
  } else if (option == CURLOPT_WRITEDATA) {
    transfer.writeData = va_arg(args, void*);
  } else if (option == CURLOPT_URL) {
    snprintf(transfer.url, sizeof(transfer.url), "%s", va_arg(args, const char*));
  }
  va_end(args);
  return CURLE_OK;
}

// Hand the answer over in chunks of 16 KiB (CURL_MAX_WRITE_SIZE), and stop when the callback takes less
CURLcode curl_easy_perform(CURL* curl) {
  (void)curl;
  const size_t chunk = 16 * 1024;
  for (size_t offset = 0; offset < transfer.answerSize; offset += chunk) {
    size_t length = transfer.answerSize - offset < chunk ? transfer.answerSize - offset : chunk;
    size_t taken = transfer.write((char*)transfer.answer + offset, 1, length, transfer.writeData);
    PHTTP_DATA data = (PHTTP_DATA)transfer.writeData;
    if (data->size > transfer.largestBuffer) {
      transfer.largestBuffer = data->size;
    }
    if (taken != length) {
      return CURLE_WRITE_ERROR;
    }
  }
  return CURLE_OK;
}

void curl_easy_cleanup(CURL* curl) {
  (void)curl;
}

const char* curl_easy_strerror(CURLcode code) {
  return code == CURLE_OK ? "No error" : "Failed writing received data to disk/application";
}

struct curl_slist* curl_slist_append(struct curl_slist* list, const char* text) {
  struct curl_slist* item = calloc(1, sizeof(*item));
  item->data = strdup(text);
  if (list == NULL) {
    return item;
  }
  struct curl_slist* last = list;
  while (last->next != NULL) {
    last = last->next;
  }
  last->next = item;
  return list;
}

void curl_slist_free_all(struct curl_slist* list) {
  while (list != NULL) {
    struct curl_slist* next = list->next;
    free(list->data);
    free(list);
    list = next;
  }
}

// An answer of the given size, filled with 'x'
static char* make_answer(size_t size) {
  char* answer = malloc(size + 1);
  memset(answer, 'x', size);
  answer[size] = 0;
  return answer;
}

// What the last request printed, which the test keeps out of its own output
static char lastOutput[4096];

// Run a request with the given answer, keeping what it prints in lastOutput
static int request(PHTTP_DATA data, const char* url, const char* answer, size_t size) {
  memset(&transfer, 0, sizeof(transfer));
  transfer.answer = answer;
  transfer.answerSize = size;

  char path[] = "/tmp/http_request_test_XXXXXX";
  int file = mkstemp(path);
  fflush(stdout);
  int saved = dup(STDOUT_FILENO);
  dup2(file, STDOUT_FILENO);
  int result = http_request(url, NULL, data);
  fflush(stdout);
  dup2(saved, STDOUT_FILENO);
  close(saved);
  lseek(file, 0, SEEK_SET);
  ssize_t length = read(file, lastOutput, sizeof(lastOutput) - 1);
  lastOutput[length > 0 ? length : 0] = 0;
  close(file);
  unlink(path);
  return result;
}

static void test_answer_within_the_limit(void) {
  PHTTP_DATA data = http_create_data();
  CHECK(data->maxSize == HTTP_MAX_RESPONSE_SIZE);
  CHECK_EQ_INT(request(data, "http://10.0.0.2:47989/serverinfo?uniqueid=0123456789ABCDEF", "<root/>", 7), GS_OK);
  CHECK_EQ_INT(data->size, 7);
  CHECK(strcmp(data->memory, "<root/>") == 0);

  char* answer = make_answer(HTTP_MAX_RESPONSE_SIZE);
  CHECK_EQ_INT(request(data, "http://10.0.0.2:47989/applist", answer, HTTP_MAX_RESPONSE_SIZE), GS_OK);
  CHECK(data->size == HTTP_MAX_RESPONSE_SIZE);
  CHECK(data->memory[HTTP_MAX_RESPONSE_SIZE] == 0);
  free(answer);
  http_free_data(data);
}

static void test_answer_over_the_limit(void) {
  PHTTP_DATA data = http_create_data();
  const size_t size = HTTP_MAX_RESPONSE_SIZE + 1;
  char* answer = make_answer(size);
  CHECK_EQ_INT(request(data, "http://10.0.0.2:47989/applist", answer, size), GS_RESPONSE_TOO_LARGE);
  CHECK(transfer.largestBuffer <= HTTP_MAX_RESPONSE_SIZE);
  CHECK(strstr(lastOutput, "CURL: the answer is larger than 4194304 bytes") != NULL);
  // The next request on the same buffer starts empty and works
  CHECK_EQ_INT(request(data, "http://10.0.0.2:47989/serverinfo", "<root/>", 7), GS_OK);
  CHECK_EQ_INT(data->size, 7);
  CHECK(strcmp(data->memory, "<root/>") == 0);
  free(answer);
  http_free_data(data);
}

static void test_box_art_limit(void) {
  // wasm/http.cpp gives the binary answers, the box art, the larger limit
  PHTTP_DATA data = http_create_data();
  data->maxSize = HTTP_MAX_BOX_ART_RESPONSE_SIZE;
  const size_t size = HTTP_MAX_RESPONSE_SIZE * 2 + 3;
  char* answer = make_answer(HTTP_MAX_BOX_ART_RESPONSE_SIZE + 1);
  CHECK_EQ_INT(request(data, "https://10.0.0.2:47984/appasset?appid=1", answer, size), GS_OK);
  CHECK(data->size == size);
  CHECK_EQ_INT(request(data, "https://10.0.0.2:47984/appasset?appid=1", answer, HTTP_MAX_BOX_ART_RESPONSE_SIZE), GS_OK);
  CHECK_EQ_INT(request(data, "https://10.0.0.2:47984/appasset?appid=1", answer, HTTP_MAX_BOX_ART_RESPONSE_SIZE + 1),
               GS_RESPONSE_TOO_LARGE);
  CHECK(transfer.largestBuffer <= HTTP_MAX_BOX_ART_RESPONSE_SIZE);
  free(answer);
  http_free_data(data);
}

// Run a request and return what it printed
static const char* logged_request(const char* url) {
  PHTTP_DATA data = http_create_data();
  request(data, url, "<root/>", 7);
  http_free_data(data);
  return lastOutput;
}

static void test_log_leaves_out_the_query(void) {
  const char* launch = "https://10.0.0.2:47984/launch?uniqueid=0123456789ABCDEF&appid=1&rikey=00112233445566778899aabbccddeeff&rikeyid=12345";
  const char* output = logged_request(launch);
  CHECK(strstr(output, "CURL: https://10.0.0.2:47984/launch?... (PPK: '<NULL>') -> No error") != NULL);
  CHECK(strstr(output, "rikey") == NULL);
  CHECK(strstr(output, "00112233445566778899aabbccddeeff") == NULL);
  // The whole URL still reaches curl
  CHECK(strcmp(transfer.url, launch) == 0);

  output = logged_request("http://10.0.0.2:47989/pair?uniqueid=0123456789ABCDEF&devicename=roth&updateState=1&clientchallenge=0f0e");
  CHECK(strstr(output, "CURL: http://10.0.0.2:47989/pair?... ") != NULL);
  CHECK(strstr(output, "clientchallenge") == NULL);

  output = logged_request("http://10.0.0.2:47989/serverinfo");
  CHECK(strstr(output, "CURL: http://10.0.0.2:47989/serverinfo (PPK") != NULL);
}

int main(void) {
  RUN_TEST("an answer up to the limit of 4 MiB is read whole", test_answer_within_the_limit);
  RUN_TEST("an answer over the limit fails with GS_RESPONSE_TOO_LARGE and the buffer stays within it",
           test_answer_over_the_limit);
  RUN_TEST("box art may have up to 16 MiB", test_box_art_limit);
  RUN_TEST("the log line of a request leaves out its query with the remote input key and the pairing secrets",
           test_log_leaves_out_the_query);
  return test_summary();
}
