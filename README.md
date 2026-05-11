# GNB News Digest

[![Daily News Scraper](https://github.com/alexanderscheibler/gnb-news-digest/actions/workflows/daily-digest.yml/badge.svg)](https://github.com/alexanderscheibler/gnb-news-digest/actions/workflows/daily-digest.yml)

A simple bilingual service providing:
- User subscription through e-mail
- Daily e-mail delivery from the news published by the Government of New Brunswick

Tech:
- Scrapping with Python (requests + BeautifulSoup)
- API with Cloudflare Workers (TypeScript)
- PostgreSQL Database with Neon
- E-mail service with Resend
- Antibot: Cloudflare Turnstile
