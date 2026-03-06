# Mise en Place — Setup Guide

## Step 1: Upload to GitHub

1. Go to **github.com** → New repository → name it `mise-en-place` → Public → Create
2. Click "uploading an existing file"
3. Upload ALL files from this folder:
   - `server.js`
   - `db.js`  
   - `package.json`
   - `public/` folder (index.html, manifest.json, sw.js)
4. Click "Commit changes"

---

## Step 2: Deploy to Railway

1. Go to **railway.app** → sign in with GitHub
2. New Project → Deploy from GitHub repo → select `mise-en-place`
3. Railway detects Node.js and starts deploying
4. Go to **Settings → Domains** → click "Generate Domain" → copy your URL
   (e.g. `mise-en-place-production.up.railway.app`)

---

## Step 3: Set Up Google Sign-In (15 mins)

### A. Create Google OAuth credentials

1. Go to **console.cloud.google.com**
2. Create a new project (name it "Mise en Place")
3. Go to **APIs & Services → OAuth consent screen**
   - User type: External → Create
   - App name: "Mise en Place"
   - Support email: your email
   - Developer contact: your email
   - Save and Continue through all steps
4. Go to **APIs & Services → Credentials**
   - Click "Create Credentials" → "OAuth client ID"
   - Application type: **Web application**
   - Name: "Mise en Place"
   - Authorised redirect URIs: add your Railway URL + `/auth/google/callback`
     e.g. `https://mise-en-place-production.up.railway.app/auth/google/callback`
   - Click Create
5. Copy the **Client ID** and **Client Secret**

### B. Add environment variables to Railway

1. In Railway, go to your project → **Variables** tab
2. Add these variables:

```
GOOGLE_CLIENT_ID     = (paste your Client ID)
GOOGLE_CLIENT_SECRET = (paste your Client Secret)
BASE_URL             = https://your-railway-url.railway.app
SESSION_SECRET       = (any random string, e.g. paste this: use-a-long-random-string-here-123456)
```

3. Railway automatically redeploys when you save variables

---

## Step 4: Add to iPhone & iPad Home Screen

1. Open **Safari** on your device
2. Go to your Railway URL
3. Sign in with Google
4. Tap the **Share button** → "Add to Home Screen" → Add
5. The app opens fullscreen like a native app ✓

---

## Step 5: Instagram Share Sheet

Once added to home screen:
1. In Instagram, find a recipe post
2. Tap **Share** (paper plane) → **More**
3. Find "Mise en Place" in the list
4. Tap it — the app opens and AI extracts the recipe automatically ✓

---

## Multiple Users

Each person signs in with their own Google account and gets their own private recipe collection. Just share the URL — anyone can sign up and their data is completely separate.

---

## Troubleshooting

**"redirect_uri_mismatch" error**: Make sure the redirect URI in Google Console exactly matches your Railway URL including `https://` and `/auth/google/callback`

**App not showing in Instagram share sheet**: Make sure you've added the app to your home screen via Safari first (not Chrome)

**Data not syncing**: Check the small dot in the top-right — green = synced, orange = syncing, red = error (check Railway logs)
