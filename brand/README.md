# Cookie Notes brand kit

`cookie-notes-logo/` is the designer's kit, kept as delivered. It is the source of truth; the app uses
copies of a few of its files:

| Where it shows | File in the app | Comes from |
| --- | --- | --- |
| Browser tab icon | `src/app/icon.svg`, `src/app/favicon.ico` | `app/icon.svg`, `app/favicon.ico` |
| iPhone/iPad home-screen icon | `src/app/apple-icon.png` | `app/apple-icon.png` |
| Razorpay Checkout window | `public/checkout-logo.png` | `app/icon-512.png` |
| Emails (needs a PNG at a public address) | `public/brand/cookie-mark-deep-128.png` | `png/cookie-mark-deep-1024.png`, resized to 128px |
| Header, sign-in, admin, About, feedback | `src/components/brand/logo.tsx` | `svg/cookie-mark-currentcolor.svg` and `svg/cookie-mark-small.svg` (paths copied, colour set to `currentColor`) |

To change the logo, replace the kit, then refresh the copies above. `icon-192.png` and `icon-512.png`
are not used yet; they are for a web app manifest, which the site does not have.
