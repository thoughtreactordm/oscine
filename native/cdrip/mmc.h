#pragma once
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace cd {
using Bytes = std::vector<uint8_t>;
constexpr int kSectorBytes = 2352, kC2Bytes = 294, kMaxSectors = 450;
struct Error : std::runtime_error {
  std::string code;
  int sector;
  Error(std::string code, std::string message, int sector = -1)
      : std::runtime_error(message), code(code), sector(sector) {}
};
struct Drive {
  std::string id, label, vendor, product;
};
struct Entry {
  int number, startSector, sectorCount;
  bool isAudio, preEmphasis;
};
struct Toc {
  std::vector<Entry> entries;
  int leadOutSector, firstTrack, lastTrack;
  Bytes cdText;
};
struct Audio {
  Bytes pcm, c2;
  bool hasC2 = false;
};
struct Transport {
  virtual ~Transport() = default;
  virtual Bytes send(const Bytes &cdb, size_t length) = 0;
};
std::vector<Drive> listDrives();
std::unique_ptr<Transport> openDrive(const std::string &id);
Bytes tocCdb(int length, bool msf = false);
Bytes readCdb(int sector, int count, bool c2);
int msfToLba(int minute, int second, int frame);
Toc parseToc(const Bytes &bytes, bool msf = false);
std::string senseCode(const Bytes &sense, int status);
void checkStatus(const Bytes &sense, int status);
Toc readToc(Transport &drive, bool withText = true);
Audio readSectors(Transport &drive, int sector, int count);
Drive identify(Transport &drive, const std::string &id);
} // namespace cd
