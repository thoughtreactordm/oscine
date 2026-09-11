#include "mmc.h"
#include <algorithm>
#include <limits>

namespace cd {
static int be16(const Bytes &b, size_t p) { return (b[p] << 8) | b[p + 1]; }
static int lba(const Bytes &b, size_t p) {
  uint32_t n = (uint32_t(b[p]) << 24) | (uint32_t(b[p + 1]) << 16) |
               (uint32_t(b[p + 2]) << 8) | b[p + 3];
  if (n > uint32_t(std::numeric_limits<int>::max()))
    throw Error("read-failed", "Negative or overflowing TOC address");
  return int(n);
}
Bytes tocCdb(int length, bool msf) {
  if (length < 4 || length > 65535)
    throw Error("read-failed", "Invalid TOC allocation length");
  return {0x43,
          uint8_t(msf ? 2 : 0),
          0,
          0,
          0,
          0,
          0,
          uint8_t(length >> 8),
          uint8_t(length),
          0};
}
Bytes readCdb(int sector, int count, bool c2) {
  if (sector < 0 || count < 1 || count > kMaxSectors ||
      sector > INT32_MAX - count)
    throw Error("read-failed", "Invalid sector range", sector);
  // Expected sector type CD-DA (001); user data only; 01 selects 294 C2 bytes.
  return {0xbe,
          0x04,
          uint8_t(sector >> 24),
          uint8_t(sector >> 16),
          uint8_t(sector >> 8),
          uint8_t(sector),
          uint8_t(count >> 16),
          uint8_t(count >> 8),
          uint8_t(count),
          uint8_t(c2 ? 0x12 : 0x10),
          0,
          0};
}
int msfToLba(int minute, int second, int frame) {
  if (minute < 0 || minute > 99 || second < 0 || second > 59 || frame < 0 ||
      frame > 74)
    throw Error("read-failed", "Invalid MSF address");
  return (minute * 60 + second) * 75 + frame - 150;
}
Toc parseToc(const Bytes &b, bool msf) {
  auto bad = [] { throw Error("read-failed", "Malformed TOC response"); };
  if (b.size() < 4)
    bad();
  size_t length = be16(b, 0) + 2;
  if (length < 20 || length > b.size() || (length - 4) % 8)
    bad();
  Toc toc{{}, 0, b[2], b[3], {}};
  if (toc.firstTrack < 1 || toc.lastTrack > 99 ||
      toc.firstTrack > toc.lastTrack ||
      length != size_t(4 + (toc.lastTrack - toc.firstTrack + 2) * 8))
    bad();
  int previous = -1;
  for (size_t p = 4; p < length; p += 8) {
    if ((b[p + 1] >> 4) != 1)
      bad();
    int start = msf ? msfToLba(b[p + 5], b[p + 6], b[p + 7]) : lba(b, p + 4);
    if (start < 0 || start <= previous)
      bad();
    if (!toc.entries.empty())
      toc.entries.back().sectorCount = start - previous;
    previous = start;
    if (p + 8 == length) {
      if (b[p + 2] != 0xaa)
        bad();
      toc.leadOutSector = start;
    } else {
      if (b[p + 2] != toc.firstTrack + toc.entries.size())
        bad();
      bool audio = !(b[p + 1] & 4);
      toc.entries.push_back(
          {b[p + 2], start, 0, audio, audio && bool(b[p + 1] & 1)});
    }
  }
  return toc;
}
std::string senseCode(const Bytes &b, int status) {
  if (status == 0x08 || status == 0x18 || status == 0x28)
    return "device-busy";
  int key = -1, asc = -1;
  if (!b.empty()) {
    int format = b[0] & 0x7f;
    if ((format == 0x70 || format == 0x71) && b.size() >= 14 && b[7] >= 6) {
      key = b[2] & 15;
      asc = b[12];
    } else if ((format == 0x72 || format == 0x73) && b.size() >= 4) {
      key = b[1] & 15;
      asc = b[2];
    }
  }
  if (key == 2 && asc == 0x3a)
    return "no-disc";
  if (key == 2 && asc == 4)
    return "device-busy";
  // Unit attention is not retried during a read: media may have changed.
  if (key == 6)
    return "device-busy";
  if (key == 5 && asc == 0x64)
    return "not-audio";
  if (key == 5 && (asc == 0x20 || asc == 0x24))
    return "unsupported-drive";
  return "read-failed";
}
void checkStatus(const Bytes &sense, int status) {
  if (status)
    throw Error(senseCode(sense, status),
                "SCSI command failed (status " + std::to_string(status) + ")");
}
Toc readToc(Transport &drive, bool withText) {
  auto toc = parseToc(drive.send(tocCdb(804), 804));
  if (withText) {
    try {
      auto command = tocCdb(4);
      command[2] = 5; // READ TOC/PMA/ATIP: CD-TEXT
      auto header = drive.send(command, 4);
      if (header.size() >= 4) {
        int length = be16(header, 0) + 2;
        if (length > 4 && length <= 65535 && (length - 4) % 18 == 0) {
          command = tocCdb(length);
          command[2] = 5;
          auto text = drive.send(command, length);
          if (text.size() == size_t(length) && be16(text, 0) + 2 == length)
            toc.cdText = std::move(text);
        }
      }
    } catch (const Error &e) {
      // Optional metadata must not make an otherwise readable disc unusable.
      // A media change, however, invalidates the TOC we just read.
      if (e.code == "no-disc" || e.code == "device-busy")
        throw;
    }
  }
  return toc;
}
Drive identify(Transport &drive, const std::string &id) {
  auto b = drive.send({0x12, 0, 0, 0, 36, 0}, 36);
  if (b.size() < 36 || (b[0] & 31) != 5)
    throw Error("unsupported-drive", "Not an optical device");
  auto field = [&](int start, int length) {
    std::string s(b.begin() + start, b.begin() + start + length);
    while (!s.empty() && s.back() == ' ')
      s.pop_back();
    return s;
  };
  auto vendor = field(8, 8), product = field(16, 16);
  return {id, vendor + " " + product, vendor, product};
}
static bool c2Supported(Transport &drive) {
  // GET CONFIGURATION, current CD Read feature (001Eh), C2 flags byte 4 bit 1.
  auto b = drive.send({0x46, 2, 0, 0x1e, 0, 0, 0, 0, 16, 0}, 16);
  return b.size() >= 16 && lba(b, 0) >= 12 && be16(b, 8) == 0x1e &&
         (b[10] & 1) && b[11] >= 4 && (b[12] & 2);
}
static Audio decode(const Bytes &b, int count, bool c2) {
  int stride = kSectorBytes + (c2 ? kC2Bytes : 0);
  if (b.size() != size_t(count * stride))
    throw Error("read-failed", "Short READ CD transfer");
  Audio out{{}, {}, c2};
  out.pcm.reserve(count * kSectorBytes);
  for (int i = 0; i < count; ++i) {
    auto begin = b.begin() + i * stride;
    // MMC CD-DA user data is already little-endian; do not swap on host
    // endianness.
    out.pcm.insert(out.pcm.end(), begin, begin + kSectorBytes);
    if (c2)
      out.c2.insert(out.c2.end(), begin + kSectorBytes, begin + stride);
  }
  return out;
}
Audio readSectors(Transport &drive, int sector, int count) {
  readCdb(sector, count, false); // validate before allocation or device I/O
  auto toc = readToc(drive, false); // Do not reread metadata for every audio chunk.
  int end = sector + count, covered = sector;
  for (const auto &entry : toc.entries) {
    if (entry.startSector <= covered &&
        covered < entry.startSector + entry.sectorCount) {
      if (!entry.isAudio)
        throw Error("not-audio", "Range intersects a data track", covered);
      covered = std::min(end, entry.startSector + entry.sectorCount);
      if (covered == end)
        break;
    }
  }
  if (covered != end)
    throw Error("not-audio", "Range is outside audio tracks", covered);
  bool c2 = false;
  try {
    c2 = c2Supported(drive);
  } catch (const Error &e) {
    if (e.code != "unsupported-drive")
      throw;
  }
  auto read = [&](int start, int n) {
    try {
      return decode(drive.send(readCdb(start, n, c2),
                               n * (kSectorBytes + (c2 ? kC2Bytes : 0))),
                    n, c2);
    } catch (const Error &e) {
      // Some firmware advertises C2 but rejects the field. Fall back
      // explicitly.
      if (!c2 || e.code != "unsupported-drive")
        throw;
      c2 = false;
      return decode(drive.send(readCdb(start, n, false), n * kSectorBytes), n,
                    false);
    }
  };
  Audio out{{}, {}, c2};
  for (int start = sector; start < end;) {
    int n =
        std::min(16, end - start); // under typical USB/Windows transfer limits
    Audio chunk;
    bool retry = false;
    try {
      chunk = read(start, n);
      retry = std::any_of(chunk.c2.begin(), chunk.c2.end(),
                          [](uint8_t b) { return b != 0; });
    } catch (const Error &e) {
      if (e.code != "read-failed")
        throw;
      retry = true;
    }
    if (retry) {
      chunk = Audio{};
      for (int s = start; s < start + n; ++s) {
        Audio single;
        for (int attempt = 0;; ++attempt) {
          try {
            single = read(s, 1);
            if (std::any_of(single.c2.begin(), single.c2.end(),
                            [](uint8_t b) { return b != 0; }))
              throw Error("read-failed", "C2 error pointers remain set", s);
            break;
          } catch (const Error &e) {
            if (e.code != "read-failed")
              throw;
            if (attempt == 3)
              throw Error(
                  "read-failed",
                  std::string(e.what()) + " at sector " + std::to_string(s), s);
          }
        }
        chunk.pcm.insert(chunk.pcm.end(), single.pcm.begin(), single.pcm.end());
        chunk.c2.insert(chunk.c2.end(), single.c2.begin(), single.c2.end());
      }
    }
    out.pcm.insert(out.pcm.end(), chunk.pcm.begin(), chunk.pcm.end());
    out.c2.insert(out.c2.end(), chunk.c2.begin(), chunk.c2.end());
    start += n;
  }
  out.hasC2 = c2;
  if (!c2)
    out.c2.clear();
  // R10 accepted: burst + bounded retries, no jitter/read-offset correction.
  // W18-5 adds double-pass hash comparison; C2 absence never proves
  // correctness.
  return out;
}
} // namespace cd
