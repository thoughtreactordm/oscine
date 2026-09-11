#include "mmc.h"
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <map>
#include <scsi/sg.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace cd {
namespace fs = std::filesystem;
static Error osError(const char *operation) {
  int e = errno;
  std::string code = "read-failed";
  if (e == ENOMEDIUM)
    code = "no-disc";
  else if (e == EBUSY || e == EAGAIN || e == EACCES || e == EPERM)
    code = "device-busy";
  else if (e == ENODEV || e == ENOENT || e == ENOTTY)
    code = "unsupported-drive";
  return Error(code, std::string(operation) + ": " + std::strerror(e));
}
static bool optical(const fs::path &path) {
  auto name = path.filename().string();
  if (path.parent_path() != "/dev" || name.size() < 3 ||
      name.substr(0, 2) != "sr" ||
      name.find_first_not_of("0123456789", 2) != std::string::npos)
    return false;
  std::ifstream type(fs::path("/sys/class/block") / name / "device/type");
  int n = -1;
  return bool(type >> n) && n == 5;
}
class LinuxDrive : public Transport {
  int fd_ = -1;

public:
  explicit LinuxDrive(const std::string &id) {
    std::error_code ec;
    auto path = fs::canonical(id, ec);
    if (ec || !optical(path))
      throw Error("unsupported-drive", "Invalid optical drive ID");
    fd_ = ::open(path.c_str(), O_RDONLY | O_NONBLOCK | O_CLOEXEC | O_NOFOLLOW);
    if (fd_ < 0)
      throw osError("open optical drive");
    struct stat st{};
    if (fstat(fd_, &st) || !S_ISBLK(st.st_mode)) {
      ::close(fd_);
      fd_ = -1;
      throw Error("unsupported-drive", "Optical drive is not a block device");
    }
  }
  ~LinuxDrive() override {
    if (fd_ >= 0)
      ::close(fd_);
  }
  Bytes send(const Bytes &command, size_t length) override {
    Bytes data(length), sense(64), cdb(command);
    sg_io_hdr_t io{};
    io.interface_id = 'S';
    io.dxfer_direction = SG_DXFER_FROM_DEV;
    io.cmd_len = static_cast<unsigned char>(cdb.size());
    io.mx_sb_len = static_cast<unsigned char>(sense.size());
    io.dxfer_len = static_cast<unsigned int>(length);
    io.dxferp = data.data();
    io.cmdp = cdb.data();
    io.sbp = sense.data();
    io.timeout = 20000;
    if (ioctl(fd_, SG_IO, &io) < 0)
      throw osError("SG_IO");
    sense.resize(io.sb_len_wr);
    checkStatus(sense, io.status);
    // DRIVER_SENSE (8) can accompany CHECK CONDITION; all other transport
    // failures must be rejected even when the target status is GOOD.
    if (io.host_status || (io.driver_status && io.driver_status != 8) ||
        (io.info & SG_INFO_OK_MASK) != SG_INFO_OK)
      throw Error("read-failed", "SG_IO transport failure");
    if (io.resid < 0 || size_t(io.resid) > length)
      throw Error("read-failed", "Invalid SG_IO residual");
    data.resize(length - io.resid);
    return data;
  }
};
std::unique_ptr<Transport> openDrive(const std::string &id) {
  return std::make_unique<LinuxDrive>(id);
}
std::vector<Drive> listDrives() {
  std::map<std::string, std::string> devices;
  auto scan = [&](const fs::path &root, bool links) {
    std::error_code ec;
    fs::directory_iterator it(root, ec), end;
    if (ec && ec != std::errc::no_such_file_or_directory)
      throw Error("read-failed",
                  "Cannot enumerate optical drives: " + ec.message());
    for (; it != end; it.increment(ec)) {
      if (ec)
        throw Error("read-failed",
                    "Cannot enumerate optical drives: " + ec.message());
      auto path = links ? fs::canonical(it->path(), ec)
                        : fs::path("/dev") / it->path().filename();
      if (ec) {
        ec.clear();
        continue;
      }
      if (!optical(path))
        continue;
      auto id = links ? it->path().string() : path.string();
      auto found = devices.find(path.string());
      if (found == devices.end() || (links && id < found->second))
        devices[path.string()] = id;
    }
  };
  // Prefer stable by-path identities, including *-cd where udev provides it.
  // Modern USB links need not have that suffix. Validate optical targets
  // instead.
  scan("/dev/disk/by-path", true);
  scan("/sys/class/block", false);
  std::vector<Drive> drives;
  for (const auto &pair : devices) {
    auto sys = fs::path("/sys/class/block") / fs::path(pair.first).filename() /
               "device";
    auto field = [&](const char *name) {
      std::ifstream file(sys / name);
      std::string s;
      std::getline(file, s);
      while (!s.empty() && s.back() == ' ')
        s.pop_back();
      return s;
    };
    auto vendor = field("vendor"), product = field("model");
    drives.push_back({pair.second, vendor + " " + product, vendor, product});
  }
  return drives;
}
} // namespace cd
