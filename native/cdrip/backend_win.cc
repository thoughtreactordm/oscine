#define NOMINMAX
#include "mmc.h"
#include <algorithm>
#include <cstddef>
#include <windows.h>

#include <ntddscsi.h>
#include <ntddstor.h>

namespace cd {
static Error osError(const char *operation) {
  DWORD e = GetLastError();
  std::string code = "read-failed";
  if (e == ERROR_NO_MEDIA_IN_DRIVE)
    code = "no-disc";
  else if (e == ERROR_BUSY || e == ERROR_NOT_READY ||
           e == ERROR_ACCESS_DENIED || e == ERROR_SHARING_VIOLATION ||
           e == ERROR_LOCK_VIOLATION)
    code = "device-busy";
  else if (e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND ||
           e == ERROR_NOT_SUPPORTED || e == ERROR_INVALID_FUNCTION ||
           e == ERROR_DEV_NOT_EXIST)
    code = "unsupported-drive";
  return Error(code, std::string(operation) + " (Windows error " +
                         std::to_string(e) + ")");
}
class WindowsDrive : public Transport {
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  ULONG alignment_ = 0;

public:
  explicit WindowsDrive(const std::string &id) {
    // Device-path construction and interpretation belong exclusively here.
    if (id.size() != 6 || id.substr(0, 4) != "\\\\.\\" || id[4] < 'A' ||
        id[4] > 'Z' || id[5] != ':')
      throw Error("unsupported-drive", "Invalid optical drive ID");
    std::string root = id.substr(4) + "\\";
    if (GetDriveTypeA(root.c_str()) != DRIVE_CDROM)
      throw Error("unsupported-drive", "Not an optical drive");
    handle_ = CreateFileA(id.c_str(), GENERIC_READ | GENERIC_WRITE,
                          FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                          OPEN_EXISTING, 0, nullptr);
    if (handle_ == INVALID_HANDLE_VALUE)
      throw osError("open optical drive");
    STORAGE_PROPERTY_QUERY query{};
    query.PropertyId = StorageAdapterProperty;
    query.QueryType = PropertyStandardQuery;
    STORAGE_ADAPTER_DESCRIPTOR descriptor{};
    DWORD returned = 0;
    if (!DeviceIoControl(handle_, IOCTL_STORAGE_QUERY_PROPERTY, &query,
                         sizeof(query), &descriptor, sizeof(descriptor),
                         &returned, nullptr)) {
      auto error = osError("query adapter alignment");
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
      throw error;
    }
    if (returned < offsetof(STORAGE_ADAPTER_DESCRIPTOR, AlignmentMask) +
                       sizeof(ULONG) ||
        descriptor.AlignmentMask > 1024 * 1024 ||
        (descriptor.AlignmentMask & (descriptor.AlignmentMask + 1)) != 0) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
      throw Error("unsupported-drive", "Invalid adapter alignment");
    }
    alignment_ = descriptor.AlignmentMask;
  }
  ~WindowsDrive() override {
    if (handle_ != INVALID_HANDLE_VALUE)
      CloseHandle(handle_);
  }
  Bytes send(const Bytes &cdb, size_t length) override {
    struct Packet {
      SCSI_PASS_THROUGH_DIRECT spt;
      UCHAR sense[64];
    } packet{};
    Bytes storage(length + alignment_);
    auto address = reinterpret_cast<uintptr_t>(storage.data());
    auto data = reinterpret_cast<uint8_t *>((address + alignment_) &
                                            ~uintptr_t(alignment_));
    auto &spt = packet.spt;
    spt.Length = sizeof(spt);
    spt.CdbLength = static_cast<UCHAR>(cdb.size());
    spt.SenseInfoLength = sizeof(packet.sense);
    spt.DataIn = SCSI_IOCTL_DATA_IN;
    spt.DataTransferLength = static_cast<ULONG>(length);
    spt.TimeOutValue = 20;
    spt.DataBuffer = data;
    spt.SenseInfoOffset = offsetof(Packet, sense);
    std::copy(cdb.begin(), cdb.end(), spt.Cdb);
    DWORD returned = 0;
    if (!DeviceIoControl(handle_, IOCTL_SCSI_PASS_THROUGH_DIRECT, &packet,
                         sizeof(packet), &packet, sizeof(packet), &returned,
                         nullptr))
      throw osError("SCSI pass-through");
    if (returned < sizeof(spt) || spt.SenseInfoLength > sizeof(packet.sense) ||
        spt.DataTransferLength > length)
      throw Error("read-failed", "Invalid pass-through response length");
    checkStatus(Bytes(packet.sense, packet.sense + spt.SenseInfoLength),
                spt.ScsiStatus);
    return Bytes(data, data + spt.DataTransferLength);
  }
};
std::unique_ptr<Transport> openDrive(const std::string &id) {
  return std::make_unique<WindowsDrive>(id);
}
std::vector<Drive> listDrives() {
  DWORD mask = GetLogicalDrives();
  if (!mask)
    throw osError("enumerate drives");
  std::vector<Drive> drives;
  for (int i = 0; i < 26; ++i) {
    if (!(mask & (1u << i)))
      continue;
    std::string letter(1, char('A' + i));
    if (GetDriveTypeA((letter + ":\\").c_str()) != DRIVE_CDROM)
      continue;
    auto id = "\\\\.\\" + letter + ":";
    try {
      auto drive = openDrive(id);
      drives.push_back(identify(*drive, id));
    } catch (const Error &) {
      // Keep inaccessible/empty drives discoverable; operations give typed
      // errors.
      drives.push_back({id, "Optical drive " + letter + ":", "", ""});
    }
  }
  return drives;
}
} // namespace cd
