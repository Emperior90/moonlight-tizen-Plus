// Pins wasm/av1_hdr_metadata.hpp: the metadata OBUs of the HDR10 static metadata that VidDecSubmitDecodeUnit() inserts
// into the keyframes of an AV1 HDR stream while 'HDR static metadata' is on, byte for byte against values worked out by
// hand from the AV1 specification (sections 5.3.1 to 5.3.4, 5.8.1, 5.8.3, 5.8.4, 6.2.4, 6.7.3 and 6.7.4): the OBU header and
// size, the metadata type, the chromaticities as 0.16 fixed point in red, green, blue order, the luminances as 24.8 and
// 18.14 fixed point, and the trailing bits; and where they go in a temporal unit (right after the sequence header), with
// temporal units that have no sequence header, already carry the metadata, or can't be read left as they are.

#include "av1_hdr_metadata.hpp"
#include "test_support.h"

#include <cstring>
#include <string>
#include <vector>

using Bytes = std::vector<unsigned char>;

static std::string Hex(const Bytes& bytes) {
  static const char* digits = "0123456789abcdef";
  std::string text;
  for (unsigned char byte : bytes) {
    text += digits[byte >> 4];
    text += digits[byte & 0x0F];
    text += ' ';
  }
  return text;
}

// The metadata of a host display with BT.2020 primaries, the D65 white point, 1000 nits peak, 0.005 nits black, MaxCLL
// 1000 and MaxFALL 400, in the units of moonlight-common-c (chromaticities normalized to 50,000, minimum in 0.0001 nits)
static SS_HDR_METADATA Bt2020Display() {
  SS_HDR_METADATA metadata = {};
  metadata.displayPrimaries[0].x = 35400;  // red 0.708
  metadata.displayPrimaries[0].y = 14600;  // red 0.292
  metadata.displayPrimaries[1].x = 8500;   // green 0.170
  metadata.displayPrimaries[1].y = 39850;  // green 0.797
  metadata.displayPrimaries[2].x = 6550;   // blue 0.131
  metadata.displayPrimaries[2].y = 2300;   // blue 0.046
  metadata.whitePoint.x = 15635;           // 0.3127
  metadata.whitePoint.y = 16450;           // 0.3290
  metadata.maxDisplayLuminance = 1000;
  metadata.minDisplayLuminance = 50;
  metadata.maxContentLightLevel = 1000;
  metadata.maxFrameAverageLightLevel = 400;
  return metadata;
}

// The two metadata OBUs of Bt2020Display(), worked out by hand: round(value / 50000 * 65536) for each chromaticity,
// 1000 * 256 for luminance_max and round(0.005 * 16384) = 82 for luminance_min
static const Bytes kMdcvObu = {
  0x2A, 0x1A, 0x02,                     // OBU_METADATA with its size field, obu_size 26, METADATA_TYPE_HDR_MDCV
  0xB5, 0x3F, 0x4A, 0xC1,               // red: 46399, 19137
  0x2B, 0x85, 0xCC, 0x08,               // green: 11141, 52232
  0x21, 0x89, 0x0B, 0xC7,               // blue: 8585, 3015
  0x50, 0x0D, 0x54, 0x39,               // white point: 20493, 21561
  0x00, 0x03, 0xE8, 0x00,               // luminance_max: 256000
  0x00, 0x00, 0x00, 0x52,               // luminance_min: 82
  0x80,                                 // trailing bits
};
static const Bytes kCllObu = {
  0x2A, 0x06, 0x01,                     // OBU_METADATA with its size field, obu_size 6, METADATA_TYPE_HDR_CLL
  0x03, 0xE8, 0x01, 0x90,               // max_cll 1000, max_fall 400
  0x80,                                 // trailing bits
};

// The OBUs of an AV1 keyframe as Sunshine sends it: a temporal delimiter, a sequence header and a frame
static const Bytes kTemporalDelimiter = {0x12, 0x00};
static const Bytes kSequenceHeader = {0x0A, 0x0B, 0x00, 0x00, 0x00, 0x2D, 0x4C, 0xFF, 0xB3, 0xDF, 0xFF, 0x98, 0x08};
static const Bytes kFrame = {0x32, 0x05, 0x10, 0x00, 0x8A, 0x7F, 0x01};

static Bytes Join(std::initializer_list<Bytes> parts) {
  Bytes result;
  for (const Bytes& part : parts) {
    result.insert(result.end(), part.begin(), part.end());
  }
  return result;
}

// Run InsertAv1HdrMetadata() on a copy of the temporal unit with room for the metadata, and return the result
static Bytes Insert(const Bytes& temporalUnit, const SS_HDR_METADATA& metadata, Av1HdrMetadataResult& result) {
  Bytes buffer(temporalUnit);
  buffer.resize(temporalUnit.size() + kAv1HdrMetadataMaxSize, 0xEE);
  size_t length = temporalUnit.size();
  result = InsertAv1HdrMetadata(buffer.data(), length, metadata);
  buffer.resize(length);
  return buffer;
}

static void TheMetadataObusMatchTheSpecificationByteForByte() {
  unsigned char out[kAv1HdrMetadataMaxSize];
  const size_t size = WriteAv1HdrMetadataObus(out, Bt2020Display());
  const Bytes written(out, out + size);
  const Bytes expected = Join({kMdcvObu, kCllObu});
  test_support::Check(written == expected, "MDCV and CLL OBUs", Hex(written), __FILE__, __LINE__);
  CHECK_EQ(size, kAv1HdrMetadataMaxSize);
  CHECK_EQ(kAv1HdrMetadataMaxSize, (size_t)36);
}

static void WithoutLightLevelsOnlyTheMasteringDisplayIsWritten() {
  SS_HDR_METADATA metadata = Bt2020Display();
  metadata.maxContentLightLevel = 0;
  metadata.maxFrameAverageLightLevel = 0;
  unsigned char out[kAv1HdrMetadataMaxSize];
  const size_t size = WriteAv1HdrMetadataObus(out, metadata);
  const Bytes written(out, out + size);
  test_support::Check(written == kMdcvObu, "MDCV only", Hex(written), __FILE__, __LINE__);
  // One of the two levels is enough for the CLL OBU
  metadata.maxFrameAverageLightLevel = 400;
  CHECK_EQ(WriteAv1HdrMetadataObus(out, metadata), kMdcvObu.size() + kCllObu.size());
}

static void TheFixedPointValuesRoundAndStayInRange() {
  CHECK_EQ(Av1Chromaticity(0), 0);
  // 50,000 is a chromaticity of 1.0, which 0.16 fixed point can't hold: the largest value instead
  CHECK_EQ(Av1Chromaticity(50000), 0xFFFF);
  CHECK_EQ(Av1Chromaticity(65535), 0xFFFF);
  // 0.5 is exactly 32768
  CHECK_EQ(Av1Chromaticity(25000), 32768);
  // A peak of 10,000 nits and a black of 6.5535 nits (the largest values that moonlight-common-c can report)
  SS_HDR_METADATA metadata = Bt2020Display();
  metadata.maxDisplayLuminance = 10000;
  metadata.minDisplayLuminance = 65535;
  unsigned char out[kAv1HdrMetadataMaxSize];
  WriteAv1HdrMetadataObus(out, metadata);
  const Bytes luminance(out + 3 + 16, out + 3 + 24);
  // 10000 * 256 = 2560000 = 0x00271000, round(6.5535 * 16384) = 107373 = 0x0001A36D
  const Bytes expected = {0x00, 0x27, 0x10, 0x00, 0x00, 0x01, 0xA3, 0x6D};
  test_support::Check(luminance == expected, "luminance fields", Hex(luminance), __FILE__, __LINE__);
}

static void TheMetadataGoesRightAfterTheSequenceHeader() {
  Av1HdrMetadataResult result;
  const Bytes keyframe = Join({kTemporalDelimiter, kSequenceHeader, kFrame});
  const Bytes withMetadata = Insert(keyframe, Bt2020Display(), result);
  CHECK(result == Av1HdrMetadataResult::kInserted);
  const Bytes expected = Join({kTemporalDelimiter, kSequenceHeader, kMdcvObu, kCllObu, kFrame});
  test_support::Check(withMetadata == expected, "temporal unit", Hex(withMetadata), __FILE__, __LINE__);
  // The result reads as a temporal unit again, with the metadata in it
  const Av1TemporalUnitInfo info = ScanAv1TemporalUnit(withMetadata.data(), withMetadata.size());
  CHECK(info.complete);
  CHECK(info.hasHdrMetadata);
  CHECK_EQ(info.sequenceHeaderEnd, kTemporalDelimiter.size() + kSequenceHeader.size());
}

static void AFrameLongerThanTheMetadataMovesIntact() {
  // 200 bytes after the sequence header: the moved part overlaps its new place, which memmove has to handle
  Bytes frame = {0x32, 0xC5, 0x01};
  for (int i = 0; i < 197; i++) {
    frame.push_back((unsigned char)(i * 13));
  }
  Av1HdrMetadataResult result;
  const Bytes withMetadata = Insert(Join({kTemporalDelimiter, kSequenceHeader, frame}), Bt2020Display(), result);
  CHECK(result == Av1HdrMetadataResult::kInserted);
  CHECK(withMetadata == Join({kTemporalDelimiter, kSequenceHeader, kMdcvObu, kCllObu, frame}));
}

static void ASequenceHeaderWithAnExtensionHeaderIsReadToo() {
  // obu_extension_flag set: one more byte after the OBU header (temporal_id 0, spatial_id 0)
  const Bytes sequenceHeader = {0x0E, 0x00, 0x03, 0x00, 0x00, 0x00};
  Av1HdrMetadataResult result;
  const Bytes withMetadata = Insert(Join({kTemporalDelimiter, sequenceHeader, kFrame}), Bt2020Display(), result);
  CHECK(result == Av1HdrMetadataResult::kInserted);
  const Bytes expected = Join({kTemporalDelimiter, sequenceHeader, kMdcvObu, kCllObu, kFrame});
  test_support::Check(withMetadata == expected, "temporal unit", Hex(withMetadata), __FILE__, __LINE__);
}

static void AFrameWithoutASequenceHeaderStaysAsItIs() {
  Av1HdrMetadataResult result;
  const Bytes frame = Join({kTemporalDelimiter, kFrame});
  CHECK(Insert(frame, Bt2020Display(), result) == frame);
  CHECK(result == Av1HdrMetadataResult::kNoSequenceHeader);
}

static void MetadataThatTheHostSentIsNotAddedTwice() {
  Av1HdrMetadataResult result;
  const Bytes keyframe = Join({kTemporalDelimiter, kSequenceHeader, kCllObu, kFrame});
  CHECK(Insert(keyframe, Bt2020Display(), result) == keyframe);
  CHECK(result == Av1HdrMetadataResult::kAlreadyPresent);
  // Metadata of another type (e.g. 4, ITU-T T.35, which carries HDR10+) doesn't count
  const Bytes t35 = {0x2A, 0x03, 0x04, 0xB5, 0x80};
  const Bytes withT35 = Join({kTemporalDelimiter, kSequenceHeader, t35, kFrame});
  const Bytes withMetadata = Insert(withT35, Bt2020Display(), result);
  CHECK(result == Av1HdrMetadataResult::kInserted);
  CHECK(withMetadata == Join({kTemporalDelimiter, kSequenceHeader, kMdcvObu, kCllObu, t35, kFrame}));
}

static void TemporalUnitsThatCantBeReadStayAsTheyAre() {
  Av1HdrMetadataResult result;
  // An OBU without its size field (allowed for the last OBU of a stream outside the low overhead format)
  const Bytes withoutSize = Join({kTemporalDelimiter, kSequenceHeader, Bytes{0x30, 0x10, 0x00}});
  CHECK(Insert(withoutSize, Bt2020Display(), result) == withoutSize);
  CHECK(result == Av1HdrMetadataResult::kNoSequenceHeader);
  // A size that runs past the end of the data
  const Bytes truncated = Join({kTemporalDelimiter, Bytes{0x0A, 0x20, 0x00, 0x00}});
  CHECK(Insert(truncated, Bt2020Display(), result) == truncated);
  CHECK(result == Av1HdrMetadataResult::kNoSequenceHeader);
  // The forbidden bit
  const Bytes forbidden = Join({Bytes{0x92, 0x00}, kSequenceHeader, kFrame});
  CHECK(Insert(forbidden, Bt2020Display(), result) == forbidden);
  CHECK(result == Av1HdrMetadataResult::kNoSequenceHeader);
  // A size field of more than 8 bytes of leb128
  const Bytes longSize = {0x0A, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00};
  CHECK(Insert(longSize, Bt2020Display(), result) == longSize);
  CHECK(result == Av1HdrMetadataResult::kNoSequenceHeader);
  // Empty data
  CHECK(Insert(Bytes(), Bt2020Display(), result).empty());
  CHECK(result == Av1HdrMetadataResult::kNoSequenceHeader);
}

static void Leb128ValuesOfSeveralBytesAreRead() {
  // 300 = 0b1_0010_1100: 0xAC, 0x02; a redundant zero continuation (0x80 0x00) is allowed
  const unsigned char data[] = {0xAC, 0x02, 0x80, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, 0xFF, 0xFF, 0xFF, 0xFF, 0x10};
  size_t offset = 0;
  uint32_t value = 0;
  CHECK(ReadAv1Leb128(data, sizeof(data), offset, value));
  CHECK_EQ(value, 300u);
  CHECK_EQ(offset, (size_t)2);
  CHECK(ReadAv1Leb128(data, sizeof(data), offset, value));
  CHECK_EQ(value, 0u);
  CHECK_EQ(offset, (size_t)4);
  // 2^32 - 1 is the largest value that fits
  CHECK(ReadAv1Leb128(data, sizeof(data), offset, value));
  CHECK_EQ(value, 0xFFFFFFFFu);
  CHECK_EQ(offset, (size_t)9);
  // 2^32 doesn't
  CHECK(!ReadAv1Leb128(data, sizeof(data), offset, value));
  // A value that runs past the end
  offset = 0;
  CHECK(!ReadAv1Leb128(data, 1, offset, value));
}

int main() {
  test_support::RunTest("the metadata OBUs match the specification byte for byte", TheMetadataObusMatchTheSpecificationByteForByte);
  test_support::RunTest("without light levels only the mastering display is written", WithoutLightLevelsOnlyTheMasteringDisplayIsWritten);
  test_support::RunTest("the fixed-point values round and stay in range", TheFixedPointValuesRoundAndStayInRange);
  test_support::RunTest("the metadata goes right after the sequence header", TheMetadataGoesRightAfterTheSequenceHeader);
  test_support::RunTest("a frame longer than the metadata moves intact", AFrameLongerThanTheMetadataMovesIntact);
  test_support::RunTest("a sequence header with an extension header is read too", ASequenceHeaderWithAnExtensionHeaderIsReadToo);
  test_support::RunTest("a frame without a sequence header stays as it is", AFrameWithoutASequenceHeaderStaysAsItIs);
  test_support::RunTest("metadata that the host sent is not added twice", MetadataThatTheHostSentIsNotAddedTwice);
  test_support::RunTest("temporal units that can't be read stay as they are", TemporalUnitsThatCantBeReadStayAsTheyAre);
  test_support::RunTest("leb128 values of several bytes are read", Leb128ValuesOfSeveralBytesAreRead);
  return test_support::Summary();
}
