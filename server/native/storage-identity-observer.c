#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/ioctl.h>
#include <linux/magic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <unistd.h>

/* Ubuntu 24.04 userspace headers predate the Linux 6.8 filesystem UUID UAPI.
 * Use the upstream ABI layout and request number when those headers are old;
 * the running kernel must still implement the ioctl or observation fails.
 * Source: linux/include/uapi/linux/fs.h (struct fsuuid2, FS_IOC_GETFSUUID).
 */
#ifndef FS_IOC_GETFSUUID
struct fsuuid2 {
  uint8_t len;
  uint8_t uuid[16];
};
#define FS_IOC_GETFSUUID _IOR(0x15, 0, struct fsuuid2)
#endif

/* The only authority is an already-open role directory inherited as fd 3. */
#define ROLE_FD 3
#define MAX_HANDLE_BYTES 128
#define MAX_MARKER_BYTES 1024

struct observed_identity {
  uint8_t uuid[16];
  int handle_type;
  unsigned int handle_bytes;
  unsigned char handle[MAX_HANDLE_BYTES];
};

static bool observe_identity(struct observed_identity *identity) {
  struct stat stat_result;
  struct statfs filesystem;
  struct fsuuid2 uuid = {0};
  struct {
    struct file_handle header;
    unsigned char bytes[MAX_HANDLE_BYTES];
  } handle = {.header.handle_bytes = MAX_HANDLE_BYTES};
  int mount_id = 0;

  if (fstat(ROLE_FD, &stat_result) || !S_ISDIR(stat_result.st_mode) ||
      fstatfs(ROLE_FD, &filesystem) ||
      filesystem.f_type != EXT4_SUPER_MAGIC ||
      ioctl(ROLE_FD, FS_IOC_GETFSUUID, &uuid) || uuid.len != 16 ||
      name_to_handle_at(ROLE_FD, "", &handle.header, &mount_id,
                        AT_EMPTY_PATH) ||
      handle.header.handle_bytes == 0 ||
      handle.header.handle_bytes > MAX_HANDLE_BYTES) {
    return false;
  }

  bool nonzero_uuid = false;
  for (size_t i = 0; i < sizeof(uuid.uuid); i++) {
    nonzero_uuid |= uuid.uuid[i] != 0;
  }
  if (!nonzero_uuid) return false;

  memcpy(identity->uuid, uuid.uuid, sizeof(identity->uuid));
  identity->handle_type = handle.header.handle_type;
  identity->handle_bytes = handle.header.handle_bytes;
  memcpy(identity->handle, handle.bytes, identity->handle_bytes);
  return true;
}

static bool same_identity(const struct observed_identity *a,
                          const struct observed_identity *b) {
  return memcmp(a->uuid, b->uuid, sizeof(a->uuid)) == 0 &&
         a->handle_type == b->handle_type &&
         a->handle_bytes == b->handle_bytes &&
         memcmp(a->handle, b->handle, a->handle_bytes) == 0;
}

static bool read_marker(unsigned char marker[MAX_MARKER_BYTES],
                        size_t *marker_bytes) {
  int fd = openat(ROLE_FD, ".saefr-storage.json",
                  O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
  if (fd < 0) return false;
  struct stat stat_result;
  bool valid = fstat(fd, &stat_result) == 0 && S_ISREG(stat_result.st_mode) &&
               stat_result.st_size > 0 &&
               stat_result.st_size <= MAX_MARKER_BYTES;
  if (valid) {
    size_t offset = 0;
    while (offset < (size_t)stat_result.st_size) {
      ssize_t read_bytes = read(fd, marker + offset,
                                (size_t)stat_result.st_size - offset);
      if (read_bytes <= 0) {
        valid = false;
        break;
      }
      offset += (size_t)read_bytes;
    }
    unsigned char extra;
    if (valid && (read(fd, &extra, 1) != 0 ||
                  offset != (size_t)stat_result.st_size)) {
      valid = false;
    }
    if (valid) *marker_bytes = offset;
  }
  if (close(fd)) valid = false;
  return valid;
}

static void hex(char *out, const unsigned char *bytes, size_t count) {
  const char alphabet[] = "0123456789abcdef";
  for (size_t i = 0; i < count; i++) {
    out[2 * i] = alphabet[bytes[i] >> 4];
    out[2 * i + 1] = alphabet[bytes[i] & 15];
  }
  out[2 * count] = '\0';
}

int main(int argc, char **argv) {
  bool with_marker = argc == 2 && strcmp(argv[1], "--observe") == 0;
  if (!with_marker && !(argc == 2 && strcmp(argv[1], "--identity") == 0))
    goto unavailable;

  struct observed_identity before, after;
  unsigned char marker[MAX_MARKER_BYTES];
  size_t marker_bytes = 0;
  if (!observe_identity(&before) ||
      (with_marker && !read_marker(marker, &marker_bytes)) ||
      !observe_identity(&after) || !same_identity(&before, &after))
    goto unavailable;

  char uuid_hex[33], handle_hex[2 * MAX_HANDLE_BYTES + 1];
  char marker_hex[2 * MAX_MARKER_BYTES + 1];
  hex(uuid_hex, before.uuid, sizeof(before.uuid));
  hex(handle_hex, before.handle, before.handle_bytes);
  if (with_marker) hex(marker_hex, marker, marker_bytes);

  int output = printf(
      "{\"filesystem_uuid\":\"%.8s-%.4s-%.4s-%.4s-%.12s\","
      "\"directory_handle_type\":%d,\"directory_handle_hex\":\"%s\"",
      uuid_hex, uuid_hex + 8, uuid_hex + 12, uuid_hex + 16, uuid_hex + 20,
      before.handle_type, handle_hex);
  if (with_marker) output += printf(",\"marker_hex\":\"%s\"", marker_hex);
  output += printf("}\n");
  return output > 0 && fflush(stdout) == 0 ? 0 : 1;

unavailable:
  /* No errno, path, filesystem identity or marker data in diagnostics. */
  fputs("storage identity unavailable\n", stderr);
  return 2;
}
