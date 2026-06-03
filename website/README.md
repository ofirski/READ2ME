# READ2ME — showcase site

A self-contained static website for the READ2ME extension. Just two files —
copy the whole folder to an S3 bucket and you're live.

```
website/
├── index.html         # the entire site (HTML + CSS + JS inline)
└── read2me-logo.png   # used as the social/OG share image
```

Fonts (Fraunces, Satoshi, JetBrains Mono) load from public CDNs, so the page
needs an internet connection in the browser but no build step and no server.

## Deploy to S3 (static website hosting)

```bash
# upload
aws s3 sync website/ s3://YOUR_BUCKET/ --delete

# one-time: enable static hosting with index.html as the entry point
aws s3 website s3://YOUR_BUCKET/ --index-document index.html
```

Make the objects publicly readable (bucket policy) or front the bucket with
CloudFront, then visit the bucket's website endpoint.
