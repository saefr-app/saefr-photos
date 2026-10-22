"""Drive a local operator CLI through a real pseudo-terminal for integration tests."""

import os
import pty
import select
import subprocess
import sys
import time


def main():
    passwords = sys.stdin.read().splitlines()
    password = passwords[0]
    confirmation = passwords[1] if len(passwords) > 1 else password
    master, slave = pty.openpty()
    command = [sys.argv[1], *sys.argv[2:]]
    child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave)
    os.close(slave)
    output = bytearray()
    prompts_sent = 0
    deadline = time.monotonic() + 20
    try:
        while child.poll() is None and time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if not ready:
                continue
            try:
                output.extend(os.read(master, 4096))
            except OSError:
                break
            if prompts_sent == 0 and b"Password: " in output:
                os.write(master, (password + "\n").encode())
                prompts_sent = 1
            if prompts_sent == 1 and b"Confirm password: " in output:
                os.write(master, (confirmation + "\n").encode())
                prompts_sent = 2
        if child.poll() is None:
            child.kill()
        child.wait(timeout=5)
        while select.select([master], [], [], 0)[0]:
            try:
                output.extend(os.read(master, 4096))
            except OSError:
                break
    finally:
        os.close(master)
    sys.stdout.buffer.write(output)
    return child.returncode if prompts_sent == 2 else 1


if __name__ == "__main__":
    sys.exit(main())
