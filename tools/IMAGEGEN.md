# IMAGEGEN — free image generation pipeline

Generates images via [Pollinations.ai](https://image.pollinations.ai) — free, keyless, no account.
Uses the `flux` model with `nologo=true`. Generation typically takes **20-60 seconds** per image.

## Usage

```powershell
powershell -File C:\Users\Olaf\Desktop\Chloe\tools\generate-image.ps1 `
    -prompt "<house prefix + subject>" `
    -out "C:\Users\Olaf\Desktop\Chloe\game\assets\gen\<name>.jpg" `
    -w 768 -h 768
```

- `-prompt` — full text prompt (URL-encoded automatically via `[uri]::EscapeDataString`)
- `-out` — absolute output path (`.jpg`); parent directory is created if missing
- `-w` / `-h` — dimensions, default 768x768

The script retries up to **3 times** until the output file exists and is **>20KB**
(small files indicate an error page or truncated download). Non-zero exit code on failure.

## House style

Prefix every prompt with the house-style string so all generated art matches the game's look:

```
photorealistic cinematic still, dark nightclub corridor lit deep red, film grain, horror ambience,
```

Then append the subject, e.g.:

```
photorealistic cinematic still, dark nightclub corridor lit deep red, film grain, horror ambience, translucent wraith made of neon smoke and static, humanoid ghost, glowing red outline, facing camera
```

## Conventions

- Output directory for generated game art: `C:\Users\Olaf\Desktop\Chloe\game\assets\gen\`
- Enemy portraits: 768x768, facing camera, subject centered
- If a result looks wrong, re-run with a reworded subject (the endpoint is non-deterministic; same prompt gives a different image each call)
