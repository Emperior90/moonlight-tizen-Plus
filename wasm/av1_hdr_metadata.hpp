#pragma once
// HDR10 static metadata for AV1 streams: the metadata OBUs (open bitstream units) for the mastering display colour volume
// (MDCV) and the content light level (CLL) that VidDecSubmitDecodeUnit() in wasm/wasmplayer.cpp inserts into the keyframes
// of an AV1 HDR stream while the switch 'HDR static metadata' is on, as it inserts SEI messages into HEVC keyframes.
// Sunshine's NVENC encoder writes only the colour description into the AV1 sequence header (BT.2020, PQ), no MDCV or CLL,
// so without them the TV tone-maps an AV1 stream without knowing the peak brightness that the host renders for.
// The header has no other dependencies, so the native tests can check it on its own (tests/native/av1_hdr_metadata_test.cpp).
//
// The syntax and the fixed-point formats follow the AV1 specification (AV1 Bitstream & Decoding Process Specification,
// sections 5.3 OBU syntax, 5.8 metadata OBU syntax and 6.7 metadata OBU semantics): every field is written most
// significant byte first, the chromaticities are 0.16 fixed point in red, green, blue order (HEVC uses green, blue, red
// and units of 0.00002), the maximum luminance 24.8 and the minimum luminance 18.14 fixed point in cd/m2.

#include <cstddef>
#include <cstdint>
#include <cstring>

#include <Limelight.h>

// The OBU types and metadata types used here
constexpr uint8_t kAv1ObuSequenceHeader = 1;
constexpr uint8_t kAv1ObuMetadata = 5;
constexpr uint8_t kAv1MetadataTypeHdrCll = 1;
constexpr uint8_t kAv1MetadataTypeHdrMdcv = 2;

// The payloads of the two metadata types: 3 primaries and the white point of 2 x 16 bits, and 2 x 32 bits of
// luminance (MDCV); the maximum content light level and the maximum frame-average light level of 16 bits each (CLL)
constexpr size_t kAv1MdcvPayloadSize = 24;
constexpr size_t kAv1CllPayloadSize = 4;

// The size of a metadata OBU: the OBU header (1 byte), its size (1 byte of leb128, since every size here is below 128),
// the metadata type (1 byte of leb128), the payload and the trailing bits (1 byte)
constexpr size_t Av1MetadataObuSize(size_t payloadSize) {
  return 1 + 1 + 1 + payloadSize + 1;
}

// The most bytes that InsertAv1HdrMetadata() adds to a temporal unit: both metadata OBUs
constexpr size_t kAv1HdrMetadataMaxSize = Av1MetadataObuSize(kAv1MdcvPayloadSize) + Av1MetadataObuSize(kAv1CllPayloadSize);

// Read an unsigned leb128 value (at most 8 bytes, as the AV1 specification allows) at offset, and move offset past it.
// Returns false when the value runs past the end of the data, is longer than 8 bytes or doesn't fit in 32 bits.
inline bool ReadAv1Leb128(const unsigned char* data, size_t length, size_t& offset, uint32_t& value) {
  uint64_t result = 0;
  for (int i = 0; i < 8; i++) {
    if (offset >= length) {
      return false;
    }
    const unsigned char byte = data[offset++];
    result |= static_cast<uint64_t>(byte & 0x7F) << (7 * i);
    if ((byte & 0x80) == 0) {
      if (result > 0xFFFFFFFFull) {
        return false;
      }
      value = static_cast<uint32_t>(result);
      return true;
    }
  }
  return false;
}

// What a temporal unit holds that the insertion depends on
struct Av1TemporalUnitInfo {
  // The offset right after the first sequence header OBU, or 0 when the temporal unit has none
  size_t sequenceHeaderEnd = 0;
  // Whether the temporal unit already carries an MDCV or a CLL metadata OBU (e.g. from a host that writes them itself)
  bool hasHdrMetadata = false;
  // Whether every OBU could be read up to the end of the data
  bool complete = false;
};

// Walk the OBUs of a temporal unit in the low overhead bitstream format, in which every OBU has its size field (as
// Sunshine sends AV1). An OBU without a size field, a forbidden bit that is set or a size that runs past the end stops
// the walk with complete = false.
inline Av1TemporalUnitInfo ScanAv1TemporalUnit(const unsigned char* data, size_t length) {
  Av1TemporalUnitInfo info;
  size_t offset = 0;
  while (offset < length) {
    const unsigned char header = data[offset];
    // obu_forbidden_bit (1), obu_type (4), obu_extension_flag (1), obu_has_size_field (1), obu_reserved_1bit (1)
    if ((header & 0x80) != 0 || (header & 0x02) == 0) {
      return info;
    }
    const uint8_t type = (header >> 3) & 0x0F;
    offset += (header & 0x04) != 0 ? 2 : 1;
    uint32_t size = 0;
    if (!ReadAv1Leb128(data, length, offset, size) || size > length - offset) {
      return info;
    }
    if (type == kAv1ObuSequenceHeader && info.sequenceHeaderEnd == 0) {
      info.sequenceHeaderEnd = offset + size;
    } else if (type == kAv1ObuMetadata && size > 0) {
      size_t metadataOffset = offset;
      uint32_t metadataType = 0;
      if (ReadAv1Leb128(data, offset + size, metadataOffset, metadataType) &&
          (metadataType == kAv1MetadataTypeHdrCll || metadataType == kAv1MetadataTypeHdrMdcv)) {
        info.hasHdrMetadata = true;
      }
    }
    offset += size;
  }
  info.complete = true;
  return info;
}

// Write a value of 16 or 32 bits most significant byte first, as f(16) and f(32) of the AV1 specification
inline unsigned char* WriteAv1BigEndian(unsigned char* out, uint32_t value, int bytes) {
  for (int i = bytes - 1; i >= 0; i--) {
    *out++ = static_cast<unsigned char>((value >> (8 * i)) & 0xFF);
  }
  return out;
}

// A chromaticity coordinate of moonlight-common-c (normalized to 50,000, as in HEVC) as 0.16 fixed point, rounded
inline uint16_t Av1Chromaticity(uint16_t normalizedTo50000) {
  const uint32_t value = (static_cast<uint32_t>(normalizedTo50000) * 65536u + 25000u) / 50000u;
  return value > 0xFFFF ? 0xFFFF : static_cast<uint16_t>(value);
}

// Write one metadata OBU with its size field and trailing bits, and return the bytes written
inline size_t WriteAv1MetadataObu(unsigned char* out, uint8_t metadataType, const unsigned char* payload, size_t payloadSize) {
  unsigned char* start = out;
  // obu_type 5 (OBU_METADATA), no extension, obu_has_size_field = 1
  *out++ = static_cast<unsigned char>((kAv1ObuMetadata << 3) | 0x02);
  // obu_size: the metadata type, the payload and the trailing bits, below 128 so one byte of leb128
  *out++ = static_cast<unsigned char>(1 + payloadSize + 1);
  *out++ = metadataType;
  std::memcpy(out, payload, payloadSize);
  out += payloadSize;
  // trailing_bits(): a one bit and zero bits up to the next byte, since the payload ends on a byte
  *out++ = 0x80;
  return static_cast<size_t>(out - start);
}

// Write the HDR10 static metadata of the host as metadata OBUs: the mastering display colour volume and, when the host
// reports them, the content light levels. Returns the bytes written (at most kAv1HdrMetadataMaxSize).
inline size_t WriteAv1HdrMetadataObus(unsigned char* out, const SS_HDR_METADATA& metadata) {
  size_t size = 0;

  unsigned char mdcv[kAv1MdcvPayloadSize];
  unsigned char* field = mdcv;
  // primary_chromaticity_x/y[i] for red, green and blue (moonlight-common-c keeps them in RGB order as well)
  for (int primary = 0; primary < 3; primary++) {
    field = WriteAv1BigEndian(field, Av1Chromaticity(metadata.displayPrimaries[primary].x), 2);
    field = WriteAv1BigEndian(field, Av1Chromaticity(metadata.displayPrimaries[primary].y), 2);
  }
  field = WriteAv1BigEndian(field, Av1Chromaticity(metadata.whitePoint.x), 2);
  field = WriteAv1BigEndian(field, Av1Chromaticity(metadata.whitePoint.y), 2);
  // luminance_max: 24.8 fixed point from whole cd/m2
  field = WriteAv1BigEndian(field, static_cast<uint32_t>(metadata.maxDisplayLuminance) * 256u, 4);
  // luminance_min: 18.14 fixed point from units of 0.0001 cd/m2, rounded
  WriteAv1BigEndian(field, (static_cast<uint32_t>(metadata.minDisplayLuminance) * 16384u + 5000u) / 10000u, 4);
  size += WriteAv1MetadataObu(out + size, kAv1MetadataTypeHdrMdcv, mdcv, sizeof(mdcv));

  if (metadata.maxContentLightLevel != 0 || metadata.maxFrameAverageLightLevel != 0) {
    unsigned char cll[kAv1CllPayloadSize];
    WriteAv1BigEndian(WriteAv1BigEndian(cll, metadata.maxContentLightLevel, 2), metadata.maxFrameAverageLightLevel, 2);
    size += WriteAv1MetadataObu(out + size, kAv1MetadataTypeHdrCll, cll, sizeof(cll));
  }

  return size;
}

// What InsertAv1HdrMetadata() did with a temporal unit
enum class Av1HdrMetadataResult {
  kInserted,
  // No sequence header (the metadata only goes into temporal units that start a sequence, as the keyframes of Sunshine
  // do), or OBUs that couldn't be read
  kNoSequenceHeader,
  // The host already sent MDCV or CLL metadata in this temporal unit, so they aren't added a second time
  kAlreadyPresent,
};

// Insert the HDR metadata OBUs right after the sequence header of the temporal unit of length bytes in data, which must
// have room for kAv1HdrMetadataMaxSize more bytes. length is updated to the new size of the temporal unit.
inline Av1HdrMetadataResult InsertAv1HdrMetadata(unsigned char* data, size_t& length, const SS_HDR_METADATA& metadata) {
  const Av1TemporalUnitInfo info = ScanAv1TemporalUnit(data, length);
  if (!info.complete || info.sequenceHeaderEnd == 0) {
    return Av1HdrMetadataResult::kNoSequenceHeader;
  }
  if (info.hasHdrMetadata) {
    return Av1HdrMetadataResult::kAlreadyPresent;
  }
  unsigned char obus[kAv1HdrMetadataMaxSize];
  const size_t size = WriteAv1HdrMetadataObus(obus, metadata);
  std::memmove(data + info.sequenceHeaderEnd + size, data + info.sequenceHeaderEnd, length - info.sequenceHeaderEnd);
  std::memcpy(data + info.sequenceHeaderEnd, obus, size);
  length += size;
  return Av1HdrMetadataResult::kInserted;
}
