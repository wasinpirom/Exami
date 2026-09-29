# 📦 ติดตั้ง Exami บน Coolify (แบบ Dockerfile ง่ายๆ)

Exami รวมทุกอย่างไว้ใน **คอนเทนเนอร์เดียว** ทั้งเว็บ ฐานข้อมูล (SQLite) และ AI (Ollama)
**ไม่ต้องตั้ง Environment Variables** เพราะตั้งค่าทุกอย่างได้จากหน้าเว็บ (ผู้ดูแล → ตั้งค่าเว็บไซต์)

> ⏱ ใช้เวลาประมาณ 10 นาที + รอดาวน์โหลดโมเดล AI `qwen3:4b` (~2.5GB) ครั้งแรกอีก 3–10 นาที
> 💻 แนะนำเซิร์ฟเวอร์ **RAM 6GB ขึ้นไป** สำหรับ qwen3:4b (ถ้ามี RAM 10GB+ อัปเกรดเป็น `qwen3:8b` ได้ในหน้า “จัดการโมเดล AI”)

---

## ขั้นที่ 1 — ชี้โดเมนมาที่เซิร์ฟเวอร์
ที่ผู้ให้บริการโดเมน เพิ่ม **A record**: `@` → IP ของเซิร์ฟเวอร์ Coolify
(ถ้าใช้ Cloudflare ให้ปิด Proxy / เมฆสีเทาไว้ก่อน จนเว็บขึ้น https แล้ว)

## ขั้นที่ 2 — สร้างแอปใน Coolify (เลือก 1 วิธี)

### วิธี A: วาง Dockerfile (ไม่ต้องเชื่อม Git) ⭐ ง่ายสุด
1. Coolify → Project → **+ New** → เลือก **Dockerfile** (แบบไม่ใช้ Git)
2. คัดลอกเนื้อหาไฟล์ [`Dockerfile.coolify`](Dockerfile.coolify) ทั้งหมดไปวาง (ไฟล์ ~2KB)
   - ถ้าใช้ GitHub ของตัวเอง ให้แก้บรรทัด `ARG REPO=...` ให้เป็นลิงก์ repo ของคุณ
3. กด **Save**

### วิธี B: ดึงจาก GitHub repo
1. Coolify → Project → **+ New** → **Public Repository** → วางลิงก์ repo → Branch `main`
2. **Build Pack:** เลือก **Dockerfile** → Save

## ขั้นที่ 3 — ตั้งค่า 3 อย่าง (ทั้งสองวิธีเหมือนกัน)
| ตั้งค่า | อยู่ที่ | ใส่ค่า |
|---|---|---|
| พอร์ต | Configuration → General → **Ports Exposes** | `3000` (ช่อง **Ports Mappings** ปล่อยว่าง) |
| โดเมน | Configuration → General → **Domains** | `https://exami.org` |
| พื้นที่เก็บข้อมูลถาวร | Configuration → **Persistent Storage** → **+ Add** → **Volume Mount** | Name: `exami-data` · Destination Path: **`/data`** |

> ⚠️ **ห้ามลืม Persistent Storage `/data`** — ถ้าไม่ใส่ ข้อมูลทั้งหมด (ผู้ใช้ ข้อสอบ โมเดล AI) จะหายเมื่อ Redeploy

## ขั้นที่ 4 — Deploy
กด **Deploy** แล้วรอ 3–5 นาที จากนั้น:
1. เปิด `https://exami.org/healthz` ต้องเห็น `{"ok":true}`
2. เปิด `https://exami.org/register` → **สมัครสมาชิกคนแรก = ผู้ดูแลระบบอัตโนมัติ**
3. ระบบเริ่มดาวน์โหลด AI `qwen3:4b` เองตั้งแต่เปิดเครื่อง — ดูความคืบหน้าที่ **ผู้ดูแล → 🤖 จัดการโมเดล AI**

## ขั้นที่ 5 — ตั้งค่าในหน้าเว็บ
ไปที่ **ผู้ดูแล → ⚙ ตั้งค่าเว็บไซต์** ตั้งได้ทุกอย่าง มีผลทันที:
ชื่อเว็บ · LINE OA · พื้นที่ต่อผู้ใช้ · ขนาดไฟล์สูงสุด · ลิงก์บริจาค · GitHub · โค้ดโฆษณา · ประกาศ · เปิด/ปิด AI · ที่อยู่ AI Server

---

## อัปเดตเวอร์ชัน
push โค้ดใหม่ขึ้น GitHub แล้วกด **Redeploy** ใน Coolify (วิธี A ก็ดึงโค้ดล่าสุดจาก GitHub ให้เองทุกครั้ง) — ข้อมูลใน `/data` อยู่ครบ

## เปลี่ยนโมเดล AI
**ผู้ดูแล → 🤖 จัดการโมเดล AI** → ดาวน์โหลด → 🧪 ทดสอบ → “ใช้โมเดลนี้” (ไม่ต้อง deploy ใหม่) ระบบแจ้งเตือนเองเมื่อมีเวอร์ชันใหม่หรือมีโมเดลแนะนำใหม่

## สำรองข้อมูล
ทุกอย่างอยู่ใน volume `/data` (`exami.db`, `uploads/`, `ollama/` = โมเดล AI)
- สำรองเฉพาะฐานข้อมูล (ทำขณะเว็บทำงานได้): Coolify → แอป → **Terminal**
  ```bash
  node -e "require('better-sqlite3')('/data/exami.db').backup('/data/backup-'+Date.now()+'.db').then(()=>console.log('ok'))"
  ```
- สำรองทั้งหมดจากเซิร์ฟเวอร์ (SSH):
  ```bash
  docker volume ls | grep exami-data            # หาชื่อ volume
  docker run --rm -v <ชื่อvolume>:/data -v "$PWD":/b alpine tar czf /b/exami-$(date +%F).tgz --exclude=./ollama -C /data .
  ```

---

## แก้ปัญหาที่พบบ่อย
| อาการ | วิธีแก้ |
|---|---|
| 502 / Bad Gateway / no available server | ตรวจ **Ports Exposes = 3000** · ดู Logs ว่ามี `Exami running on ...` |
| ข้อมูลหายหลัง Redeploy | ยังไม่ได้ใส่ **Persistent Storage → `/data`** (ขั้นที่ 3) |
| AI: “ยังไม่พบโมเดล…” | โมเดลยังดาวน์โหลดไม่เสร็จ ดูที่หน้า **จัดการโมเดล AI** |
| AI ช้ามาก / เซิร์ฟเวอร์ค้าง | RAM ไม่พอ → เปลี่ยนเป็นโมเดลเล็กลง เช่น `qwen2.5:3b` ในหน้าจัดการโมเดล AI แล้วลบตัวใหญ่ออก |
| ล็อกอินแล้วเด้งออก | เข้าเว็บด้วย `https://` |
| **ลืมรหัสผ่านแอดมิน** | Coolify → แอป → Terminal (แก้อีเมล/รหัสใหม่):<br>`node -e "require('better-sqlite3')('/data/exami.db').prepare('UPDATE users SET password_hash=? WHERE email=?').run(require('bcryptjs').hashSync('รหัสใหม่',10),'อีเมล')"` |

---

## ติดตั้งแบบไม่ใช้ Coolify (VPS ที่มี Docker)
```bash
git clone https://github.com/<ชื่อผู้ใช้>/exami.git && cd exami
docker compose up -d --build        # เปิด http://<IP>:3000
```
ทำ HTTPS ด้วย Caddy: ใส่ใน `/etc/caddy/Caddyfile` → `exami.org { reverse_proxy localhost:3000 }` แล้ว `systemctl reload caddy`

**รันบนเครื่องตัวเองเพื่อพัฒนา** (Node.js 22+ และติดตั้ง Ollama แล้ว): `npm install && npm run dev` → http://localhost:3000
