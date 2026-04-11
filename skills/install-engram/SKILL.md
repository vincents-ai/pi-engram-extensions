---
name: install-engram
description: Install the engram CLI binary and bootstrap a project workspace. Covers all platforms (Linux, macOS, Windows, NixOS) via the one-line installer, direct binary download, nix, or cargo. Also runs the post-install bootstrap sequence (workspace init, agent registration, skills install, commit hook). Use when engram is missing, needs upgrading, or a new project needs initialising.
---

# Install Engram

Engram is a distributed memory system for AI agents. This skill installs the
`engram` CLI and optionally bootstraps a project workspace.

**Source:** https://github.com/vincents-ai/engram  
**Latest release:** https://github.com/vincents-ai/engram/releases/latest

---

## Step 1 — Check if engram is already installed

```bash
engram --version
```

If a version is printed, engram is installed. Skip to [Bootstrap](#step-3--bootstrap-the-workspace) if the workspace also needs initialising, or you're done.

If not found, continue to Step 2.

---

## Step 2 — Install the binary

Choose the method that fits the environment.

### Recommended: one-line installer (Linux / macOS)

Detects the platform, downloads the right binary, installs to `/usr/local/bin`
(or `~/.local/bin` if no sudo), and optionally runs the bootstrap interactively.

```bash
curl -fsSL https://github.com/vincents-ai/engram/releases/latest/download/install.sh | bash
```

To skip the interactive bootstrap (agent-driven installs):

```bash
curl -fsSL https://github.com/vincents-ai/engram/releases/latest/download/install.sh | bash -s -- --no-bootstrap
```

> The installer prompts before every step — it will not apply anything without confirmation.

---

### Manual binary install (when curl is unavailable or you need a specific version)

Download and extract the binary for your platform:

**Linux x86_64 (glibc — Ubuntu, Debian, Fedora, Arch, etc.)**
```bash
curl -L https://github.com/vincents-ai/engram/releases/latest/download/engram-linux-amd64.tar.gz | tar xz
chmod +x engram && sudo mv engram /usr/local/bin/
```

**Linux x86_64 (musl — NixOS, Alpine, containers, static environments)**
```bash
curl -L https://github.com/vincents-ai/engram/releases/latest/download/engram-linux-musl-amd64.tar.gz | tar xz
chmod +x engram && sudo mv engram /usr/local/bin/
```

**macOS Apple Silicon (M1/M2/M3)**
```bash
curl -L https://github.com/vincents-ai/engram/releases/latest/download/engram-macos-arm64.tar.gz | tar xz
chmod +x engram && sudo mv engram /usr/local/bin/
```

**macOS Intel**
```bash
curl -L https://github.com/vincents-ai/engram/releases/latest/download/engram-macos-amd64.tar.gz | tar xz
chmod +x engram && sudo mv engram /usr/local/bin/
```

**Windows x86_64**

Download `engram-windows-amd64.zip` from https://github.com/vincents-ai/engram/releases/latest,
extract it, and add the directory containing `engram.exe` to your `PATH`.

---

### Nix / NixOS

Run without installing (for a one-off use):
```bash
nix run github:vincents-ai/engram -- --help
```

Install to your nix profile (persists across shells):
```bash
nix profile install github:vincents-ai/engram
```

Build and run from source with nix:
```bash
nix build github:vincents-ai/engram
./result/bin/engram --help
```

---

### Cargo (build from source)

Requires a Rust toolchain (`rustup` recommended):
```bash
cargo install engram
```

Or clone and build manually:
```bash
git clone https://github.com/vincents-ai/engram.git
cd engram
cargo build --release
# Binary at: ./target/release/engram
sudo cp target/release/engram /usr/local/bin/
```

---

## Step 3 — Verify the install

```bash
engram --version
```

Expected output: `engram X.Y.Z`

If `engram` is not found after install, check your PATH:
```bash
# For ~/.local/bin installs:
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# For cargo installs:
export PATH="$HOME/.cargo/bin:$PATH"
```

---

## Step 4 — Bootstrap the workspace

Run these in the project root. Each command is safe to run on its own — skip any steps that have already been done.

### 1. Initialise the workspace

Creates `.engram/` config in the current directory (git-native storage under `refs/engram/`):

```bash
engram setup workspace
```

### 2. Register an agent profile

```bash
# For an AI agent (implementation role):
engram setup agent --name "Claude" --agent-type implementation

# For a human operator:
engram setup agent --name "Your Name" --agent-type operator

# Available agent types: operator | implementation | quality_assurance | architecture
```

### 3. Install core engram skills

Installs 14 skills that teach the LLM how to use engram correctly (search-before-acting,
store-everything, orchestration, subagent delegation, etc.):

```bash
engram skills setup
```

### 4. Install all skills (optional — 44 skills total)

Adds planning, architecture, review, debugging, TDD, compliance, and more:

```bash
engram setup skills
```

### 5. Install the commit-msg hook (strongly recommended)

Enforces task UUID linkage on every commit — rejects commits without a valid UUID:

```bash
engram validate hook install
```

---

## What each bootstrap step installs

| Step | Command | Output |
|------|---------|--------|
| Workspace | `engram setup workspace` | `.engram/` + `config.yaml` |
| Agent profile | `engram setup agent ...` | `.engram/agents/<name>.yaml` |
| Core skills (14) | `engram skills setup` | `~/.config/engram/skills/` (or pi skill path) |
| All skills (44) | `engram setup skills` | same as above, full set |
| Commit hook | `engram validate hook install` | `.git/hooks/commit-msg` |

---

## Minimal agent setup (steps 1–3 only)

For a fully functional agent session with no hook enforcement:

```bash
engram setup workspace
engram setup agent --name "Claude" --agent-type implementation
engram skills setup
```

---

## Verifying the workspace

```bash
# Check workspace health
engram validate check

# Run a search to confirm the store is queryable
engram ask query "test"

# See what task to work on next
engram next
```

---

## Troubleshooting

**`engram: command not found` after install**  
The binary was installed outside your PATH. Run:
```bash
./scripts/check-install.sh
```
or manually check: `ls ~/.local/bin/engram`, `ls /usr/local/bin/engram`, `ls ~/.cargo/bin/engram`

**Musl vs glibc: which do I need?**  
Run `ldd --version 2>&1`. If it says `musl`, use the musl binary. If it says `GLIBC`, use the standard linux-amd64 binary. NixOS always uses musl.

**`Permission denied` moving binary to `/usr/local/bin`**  
Install to `~/.local/bin` instead:
```bash
mkdir -p ~/.local/bin
mv engram ~/.local/bin/
export PATH="$HOME/.local/bin:$PATH"
```

**`engram setup workspace` fails: "not a git repository"**  
Engram stores data in git refs — the current directory must be a git repo:
```bash
git init
engram setup workspace
```
