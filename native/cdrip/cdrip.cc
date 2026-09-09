#include "mmc.h"
#include <cmath>
#include <functional>
#include <map>
#include <mutex>
#include <napi.h>

namespace {
Napi::Error jsError(Napi::Env env, const cd::Error &error) {
  auto e = Napi::Error::New(env, error.what());
  e.Set("code", error.code);
  if (error.sector >= 0)
    e.Set("sector", double(error.sector));
  return e;
}
Napi::Object tocValue(Napi::Env env, const cd::Toc &toc) {
  auto out = Napi::Object::New(env);
  auto entries = Napi::Array::New(env, toc.entries.size());
  for (size_t i = 0; i < toc.entries.size(); ++i) {
    const auto &t = toc.entries[i];
    auto entry = Napi::Object::New(env);
    entry.Set("number", t.number);
    entry.Set("startSector", t.startSector);
    entry.Set("sectorCount", t.sectorCount);
    entry.Set("isAudio", t.isAudio);
    entry.Set("preEmphasis", t.preEmphasis);
    entries.Set(uint32_t(i), entry);
  }
  out.Set("entries", entries);
  out.Set("leadOutSector", toc.leadOutSector);
  out.Set("firstTrack", toc.firstTrack);
  out.Set("lastTrack", toc.lastTrack);
  if (!toc.cdText.empty())
    out.Set("cdText", Napi::Buffer<uint8_t>::Copy(env, toc.cdText.data(), toc.cdText.size()));
  return out;
}
Napi::Buffer<uint8_t> buffer(Napi::Env env, const cd::Bytes &bytes) {
  return Napi::Buffer<uint8_t>::Copy(env, bytes.data(), bytes.size());
}
Napi::Object audioValue(Napi::Env env, const cd::Audio &audio) {
  auto out = Napi::Object::New(env);
  out.Set("pcm", buffer(env, audio.pcm));
  if (audio.hasC2)
    out.Set("c2", buffer(env, audio.c2));
  else
    out.Set("c2", env.Null());
  return out;
}
int integer(const Napi::Value &value) {
  if (!value.IsNumber())
    throw Napi::TypeError::New(value.Env(), "Expected an integer");
  double n = value.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(n) || std::floor(n) != n || n < 0 || n > INT32_MAX)
    throw Napi::RangeError::New(value.Env(), "Integer is out of range");
  return int(n);
}
cd::Bytes bytes(const Napi::Value &value) {
  if (!value.IsBuffer())
    throw Napi::TypeError::New(value.Env(), "Expected a Buffer");
  auto b = value.As<Napi::Buffer<uint8_t>>();
  return cd::Bytes(b.Data(), b.Data() + b.Length());
}
// No JS handles in this registry. Shared across worker-thread addon instances.
std::mutex registryMutex;
std::map<std::string, std::weak_ptr<std::mutex>> locks;
std::shared_ptr<std::mutex> deviceLock(const std::string &id) {
  std::lock_guard<std::mutex> lock(registryMutex);
  for (auto it = locks.begin(); it != locks.end();) {
    if (it->second.expired())
      it = locks.erase(it);
    else
      ++it;
  }
  auto shared = locks[id].lock();
  if (!shared) {
    shared = std::make_shared<std::mutex>();
    locks[id] = shared;
  }
  return shared;
}
class Work : public Napi::AsyncWorker {
  Napi::Promise::Deferred promise_;
  std::string op_, id_, code_;
  int sector_, count_, failedSector_ = -1;
  std::vector<cd::Drive> drives_;
  cd::Toc toc_{};
  cd::Audio audio_;

public:
  Work(Napi::Env env, std::string op, std::string id, int sector, int count)
      : AsyncWorker(env, "cdrip:device"),
        promise_(Napi::Promise::Deferred::New(env)), op_(op), id_(id),
        sector_(sector), count_(count) {}
  Napi::Promise Promise() { return promise_.Promise(); }
  void Execute() override {
    try {
      if (op_ == "list") {
        drives_ = cd::listDrives();
        return;
      }
      auto mutex = deviceLock(id_);
      std::unique_lock<std::mutex> lock(*mutex, std::try_to_lock);
      if (!lock.owns_lock())
        throw cd::Error("device-busy",
                        "An operation is already using this drive");
      auto drive = cd::openDrive(id_);
      if (op_ == "toc")
        toc_ = cd::readToc(*drive);
      else
        audio_ = cd::readSectors(*drive, sector_, count_);
    } catch (const cd::Error &e) {
      code_ = e.code;
      failedSector_ = e.sector;
      SetError(e.what());
    } catch (const std::exception &e) {
      code_ = "read-failed";
      SetError(e.what());
    }
  }
  void OnOK() override {
    auto env = Env();
    if (op_ == "toc")
      promise_.Resolve(tocValue(env, toc_));
    else if (op_ == "read")
      promise_.Resolve(audioValue(env, audio_));
    else {
      auto list = Napi::Array::New(env, drives_.size());
      for (size_t i = 0; i < drives_.size(); ++i) {
        auto d = Napi::Object::New(env);
        d.Set("id", drives_[i].id);
        d.Set("label", drives_[i].label);
        d.Set("vendor", drives_[i].vendor);
        d.Set("product", drives_[i].product);
        list.Set(uint32_t(i), d);
      }
      promise_.Resolve(list);
    }
  }
  void OnError(const Napi::Error &error) override {
    auto e = jsError(Env(), cd::Error(code_.empty() ? "read-failed" : code_,
                                      error.Message(), failedSector_));
    promise_.Reject(e.Value());
  }
};
Napi::Value queue(const Napi::CallbackInfo &info, const char *op) {
  std::string id;
  int sector = 0, count = 0;
  if (std::string(op) != "list") {
    if (!info[0].IsString())
      throw Napi::TypeError::New(info.Env(), "Expected an opaque drive ID");
    id = info[0].As<Napi::String>().Utf8Value();
    if (id.empty() || id.size() > 4096 || id.find('\0') != std::string::npos)
      throw Napi::TypeError::New(info.Env(), "Invalid drive ID");
  }
  if (std::string(op) == "read") {
    sector = integer(info[1]);
    count = integer(info[2]);
    if (count < 1 || count > cd::kMaxSectors || sector > INT32_MAX - count)
      throw Napi::RangeError::New(
          info.Env(), "count must be 1..450 and range must fit int32");
  }
  auto work = std::make_unique<Work>(info.Env(), op, id, sector, count);
  auto promise = work->Promise();
  work->Queue();
  work.release();
  return promise;
}
// This seam exercises the actual C++ MMC implementation in Vitest, with no
// device open or arbitrary pass-through export. It is absent from the TS API.
struct Script : cd::Transport {
  struct Step {
    cd::Bytes response;
    std::string error;
  };
  std::vector<Step> steps;
  std::vector<cd::Bytes> commands;
  cd::Bytes send(const cd::Bytes &cdb, size_t) override {
    size_t i = commands.size();
    commands.push_back(cdb);
    if (i >= steps.size())
      throw cd::Error("read-failed", "Script exhausted");
    if (!steps[i].error.empty())
      throw cd::Error(steps[i].error, "Scripted error");
    return steps[i].response;
  }
};
Napi::Value test(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  try {
    auto op = info[0].As<Napi::String>().Utf8Value();
    if (op == "tocCdb")
      return buffer(env, cd::tocCdb(integer(info[1]), info[2].ToBoolean()));
    if (op == "readCdb")
      return buffer(env, cd::readCdb(integer(info[1]), integer(info[2]),
                                     info[3].ToBoolean()));
    if (op == "parseToc")
      return tocValue(env, cd::parseToc(bytes(info[1]), info[2].ToBoolean()));
    if (op == "msfToLba")
      return Napi::Number::New(
          env,
          cd::msfToLba(integer(info[1]), integer(info[2]), integer(info[3])));
    if (op == "senseCode")
      return Napi::String::New(env,
                               cd::senseCode(bytes(info[1]), integer(info[2])));
    if (op == "readScript" || op == "tocScript") {
      Script script;
      auto steps = info[3].As<Napi::Array>();
      for (uint32_t i = 0; i < steps.Length(); ++i) {
        auto step = steps.Get(i);
        if (step.IsString())
          script.steps.push_back({{}, step.As<Napi::String>().Utf8Value()});
        else
          script.steps.push_back({bytes(step), ""});
      }
      auto result = Napi::Object::New(env);
      try {
        if (op == "tocScript")
          result.Set("toc", tocValue(env, cd::readToc(script)));
        else result.Set("audio",
                   audioValue(env, cd::readSectors(script, integer(info[1]),
                                                   integer(info[2]))));
      } catch (const cd::Error &e) {
        result.Set("error", jsError(env, e).Value());
      }
      auto commands = Napi::Array::New(env, script.commands.size());
      for (size_t i = 0; i < script.commands.size(); ++i)
        commands.Set(uint32_t(i), buffer(env, script.commands[i]));
      result.Set("commands", commands);
      return result;
    }
    throw Napi::TypeError::New(env, "Unknown test operation");
  } catch (const cd::Error &e) {
    throw jsError(env, e);
  }
}
Napi::Object init(Napi::Env env, Napi::Object exports) {
  exports.Set("listDrives",
              Napi::Function::New(env, [](const Napi::CallbackInfo &i) {
                return queue(i, "list");
              }));
  exports.Set("readToc",
              Napi::Function::New(env, [](const Napi::CallbackInfo &i) {
                return queue(i, "toc");
              }));
  exports.Set("readSectors",
              Napi::Function::New(env, [](const Napi::CallbackInfo &i) {
                return queue(i, "read");
              }));
  exports.Set("_test", Napi::Function::New(env, test));
  return exports;
}
} // namespace
NODE_API_MODULE(cdrip, init)
