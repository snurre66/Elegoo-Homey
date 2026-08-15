# Publishing to the Homey App Store

## Prerequisites

Before publishing, ensure `.secret.json` exists at the root of the repository
with your real personal information. This file is gitignored and will never be
committed to GitHub.

Create it by copying the template:

```
cp .secret.json.example .secret.json
```

Then fill in your actual values:

```json
{
  "AUTHOR_NAME": "Your Full Name",
  "AUTHOR_EMAIL": "your@email.com",
  "PAYPAL_USERNAME": "your-paypal-username"
}
```

## Publishing

Run the safe publish script. It will:

1. Read `.secret.json` and inject your real info into `app.json` and `package.json`
2. Run `npx homey app publish`
3. Automatically restore the `<HIDDEN>` placeholders when done

```bash
npm run publish:safe
```

## Important Notes

- **Never run `npx homey app publish` directly** — the manifests currently contain
  `<HIDDEN>` placeholders. The safe script handles the injection/restore cycle.
- **Never commit `.secret.json`** — it is in `.gitignore` for a reason.
- The `app.json` and `package.json` in the repo intentionally show `<HIDDEN>` for
  all personal fields (author name, email, PayPal username).

## Installing Locally (No Secrets Needed)

For local testing, just use:

```bash
npx homey app install
```

This does not require your personal info to be present.
