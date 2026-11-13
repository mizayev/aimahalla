# 🏘️ Mening mahallam

Virtual mahalla xaritasi: **1 a'zo = 1 hovli**.

Har bir odam saytga kirib, nik va PIN-kod bilan mahallaga qo'shiladi va o'z hovlisini oladi. Kim ertaroq qo'shilsa, hovlisi markazga shuncha yaqin bo'ladi. Keyin hovlisi o'rnida osmono'par quradi. Barcha o'zgarishlarni hamma jonli ko'radi.

## Imkoniyatlar

- 🗺️ Xarita barmoq yoki sichqoncha bilan suriladi va kattalashtiriladi. Markazda bog', favvora, IT minora, guzar, choyxona, bozor, maktab va to'yxona bor.
- 🏠 Qo'shilish: nik, PIN-kod va tom rangini tanlash. Kirish/chiqish ham bor.
- 🏗️ Osmono'par qurish: har gal +5 qavat qo'shiladi. Odatda 1 soatda bir marta, eng ko'pi 100 qavat.
- 🔍 Nik bo'yicha qidirish. 🔗 Hovlingiz havolasini ulashish (`saytingiz.uz/?u=nik`).
- 🏆 Reyting: eng baland binolar va yangi qo'shnilar.
- 🔴 Jonli rejim: yangi qo'shnilar va qurilishlar hamma ekranida darhol paydo bo'ladi, onlayn odamlar soni ko'rinadi.
- 🌙 Tun rejimi: kechqurun avtomatik yoqiladi, derazalar va chiroqlar yonadi.
- 🌐 Tillar: o'zbek, rus, ingliz.
- ⚙️ Admin paneli: mahalla nomi va shiorini o'zgartirish, qavat qo'shish yoki ayirish, a'zoni o'chirish.

Hech qanday qo'shimcha kutubxona kerak emas, faqat **Node.js 18+** bo'lsa yetadi.

## Kompyuterda ishga tushirish

```bash
ADMIN_PASSWORD=maxfiyParol123 node server.js
```

Keyin brauzerda `http://localhost:3000` ni oching.

## Sozlamalar (muhit o'zgaruvchilari)

| O'zgaruvchi | Vazifasi | Standart |
|---|---|---|
| `PORT` | Server porti | `3000` |
| `ADMIN_PASSWORD` | Admin paroli, kamida 6 belgi. Bo'lmasa admin paneli o'chiq | — |
| `BUILD_COOLDOWN_MIN` | Qurilishlar orasidagi kutish vaqti, daqiqada | `60` |
| `MAX_FLOORS` | Eng ko'p qavat soni | `100` |
| `DATA_DIR` | Ma'lumotlar saqlanadigan papka | `./data` |

## Admin paneli

Saytni `?admin` qo'shib oching, masalan `https://saytingiz.uz/?admin`, va parolni kiriting. Shundan keyin pastda **⚙️ Boshqaruv** tugmasi chiqadi. Istalgan hovlini bossangiz, uni boshqarish tugmalari (+5, −5, o'chirish) ko'rinadi.

## Internetga joylash

Ma'lumotlar `data/db.json` faylida saqlanadi. Shuning uchun hosting **doimiy disk** (persistent volume) bera olishi shart, aks holda qayta ishga tushganda aholi o'chib ketadi.

### 1-variant: Railway (eng oson)
1. Loyihani GitHub'ga yuklang.
2. [railway.app](https://railway.app) saytida **New Project → Deploy from GitHub** ni tanlang.
3. **Variables** bo'limiga `ADMIN_PASSWORD` va `DATA_DIR=/data` ni qo'shing.
4. **Volumes** bo'limida `/data` papkasiga volume ulang.
5. **Settings → Networking → Generate Domain** orqali havola oling. O'z domeningizni ham ulash mumkin.

### 2-variant: O'z serveringiz (VPS)
```bash
git clone <repo> mahalla && cd mahalla
npm i -g pm2
ADMIN_PASSWORD=maxfiyParol123 pm2 start server.js --name mahalla
pm2 save && pm2 startup
```
Oldiga Nginx yoki Caddy qo'yib, HTTPS ulang. Nginx ishlatsangiz, `/api/events` uchun `proxy_buffering off;` qo'shing.

> ⚠️ Render.com'ning bepul tarifida disk saqlanmaydi, shuning uchun u bu loyihaga mos emas.

## Zaxira nusxa

Ma'lumotlarning hammasi bitta faylda: `data/db.json`. Uni vaqti-vaqti bilan nusxalab qo'ying.

## Xavfsizlik

- PIN-kodlar ochiq holda saqlanmaydi (scrypt bilan xeshlanadi).
- Qo'shilish, kirish va admin paroliga urinishlar soni cheklangan.
- Nik faqat harf, raqam, `_`, `.` va `-` belgilaridan iborat bo'lishi mumkin.
