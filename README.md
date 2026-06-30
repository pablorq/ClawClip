# 🦀📎 ClawClip

### *Supercharge Paperclip with the Power of OpenClaw Agents*

**ClawClip** is the high-performance, drop-in adapter that seamlessly connects **Paperclip** to the **OpenClaw Gateway**. Keep your control plane running smoothly with zero payload bloat, automatic skill synchronization, and robust device authentication.

---

## ⚡ Project Status & Badges

[![npm version](https://img.shields.io/npm/v/clawclip.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/clawclip)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node.js Compatibility](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-orange.svg?style=flat-square)](http://makeapullrequest.com)

---

## ✨ Features

* **🧼 Zero Payload Bloat:** Automatically sanitizes application parameters to satisfy strict gateway policies.
* **🔒 Isolated Sandboxes:** Partitioned agent workspaces (`agents/<id>` vs `main`) to prevent file/run conflicts.
* **⚡ Smart Skill Sync:** Fast hash check synchronizes local skill directories with remote agents instantly.
* **🧩 Session Continuity:** Flexible context persistence tailored to your workflow (`fixed`, `issue`, or `run`).

---

## 🚀 Get Started in 30 Seconds

Connect ClawClip to your Paperclip instance in two simple steps.

### 1. Install the Adapter
Send a request to your Paperclip instance to install the adapter:

**Option A: From NPM (Recommended)**
Go to Paperclip > Instance Settings > Adapters > Install Adapter:
- Option: NPM package
- Package Name: clawclip

**Option B: From Local Source**
To install ClawClip from source, you must first clone the repository and build the package:
1. Clone the repository and navigate into it:
   ```bash
   git clone https://github.com/pablorq/ClawClip.git
   cd ClawClip
   ```
2. Install the dependencies and build the adapter:
   ```bash
   npm install
   npm run build
   ```
3. In Paperclip, go to **Instance Settings** > **Adapters** > **Install Adapter**:
   - **Option**: Local path
   - **Path to adapter package**: `/path/to/ClawClip` (the directory where you cloned and built the repository)

If Paperclip is running in a container, you will need to mount the ClawClip directory to the container and then use the path to the mounted directory as the path to the adapter package.


### 2. Configure Your Agent
In the Paperclip UI agent configuration, set the adapter type to **`clawclip`**.

#### ⚙️ Configuration Parameters

* **Gateway WebSocket URL** *(Required)*: The WebSocket address of your OpenClaw gateway (e.g., `wss://openclaw-gateway.example.com`).
* **Gateway Auth Token** *(Required)*: Your secure access token for the gateway.
* **Session Key Strategy** *(Optional)*: Choose how your context is preserved:
  * `fixed`: Keeps one persistent, shared agent session.
  * `issue`: Creates a dedicated session for each unique issue (default).
  * `run`: Spawns a clean session for every action.
* **Fixed Session Key** *(Optional)*: Only used when `sessionKeyStrategy` is `fixed`.
* **Enable Skill Sync** *(Optional)*: Automatically keeps your local skill directory and remote agent environment aligned (default: `false`).
* **Paperclip API URL** *(Required)*: Absolute Paperclip base URL to include in wake text.
* **Enable Debug Mode** *(Optional)*: Enable debug logging for the ClawClip adapter and WebSocket gateway (default: `false`).

---

## 🎯 Troubleshooting

### ❌ `pairing required: device is not approved yet`
Approval is pending on the gateway. Head to your **OpenClaw Dashboard**, approve the device request, and restart.


---

## 📄 License

ClawClip is proudly open-source software under the **[MIT License](https://www.google.com/search?q=LICENSE)**.
