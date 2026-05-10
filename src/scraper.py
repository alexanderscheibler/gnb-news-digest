# scraper.py
import os
import requests
from bs4 import BeautifulSoup
import psycopg2
from psycopg2.extras import DictCursor
import resend
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import base64
from datetime import datetime, date
from typing import List, Dict

resend.api_key = os.environ["RESEND_API_KEY"]
DB_URL = os.environ["NEON_DB_URL"]

# Initialize AES-GCM
MASTER_KEY = bytes.fromhex(os.environ["APP_MASTER_KEY"])
aesgcm = AESGCM(MASTER_KEY)

URLS = {
    "en": "https://www.gnb.ca/en/news/latest.html",
    "fr": "https://www.gnb.ca/fr/nouvelles/recentes.html"
}

# Determine the target date (Use TEST_DATE env var if provided, otherwise today)
test_date_str = os.environ.get("TEST_DATE")
if test_date_str:
    TARGET_DATE = datetime.strptime(test_date_str, "%Y-%m-%d").date()
    print(f"🛠️ RUNNING IN TEST MODE: Forcing target date to {TARGET_DATE}")
else:
    TARGET_DATE = date.today()


def decrypt_email(encrypted_b64: str) -> str:
    """Decrypts the base64 encoded nonce + ciphertext."""
    raw_bytes = base64.b64decode(encrypted_b64)
    nonce = raw_bytes[:12]
    ciphertext = raw_bytes[12:]
    plaintext_bytes = aesgcm.decrypt(nonce, ciphertext, None)
    return plaintext_bytes.decode('utf-8')


def fetch_headlines(url: str, lang: str) -> List[Dict[str, str]]:
    """Fetches news and filters strictly by the TARGET_DATE."""
    response = requests.get(url, timeout=10)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, 'html.parser')

    headlines: List[Dict[str, str]] = []

    # Format date strings exactly as they appear in the GNB page
    if lang == "en":
        target_date_str = f"{TARGET_DATE.strftime('%B')} {TARGET_DATE.day}, {TARGET_DATE.year}"  # e.g., "May 5, 2026"
    else:
        months_fr = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
                     "novembre", "décembre"]
        target_date_str = f"{TARGET_DATE.day} {months_fr[TARGET_DATE.month - 1]} {TARGET_DATE.year}"  # e.g., "5 mai 2026"

    print(f"🔍 Looking for date string: '{target_date_str}'")

    for container in soup.find_all(['div', 'li', 'article', 'tr']):
        text_content = container.get_text(separator=' ', strip=True)

        if 20 < len(text_content) < 1500 and target_date_str.lower() in text_content.lower():
            links = container.find_all('a')
            for a_tag in links:
                title = a_tag.get_text(strip=True)
                link = a_tag.get('href')

                # Heuristic: News headlines usually have a decent length (> 4 words).
                # This filters out 'Department of Health' or 'Read more' buttons.
                if title and link and len(title.split()) > 4:
                    if link.startswith('/'):
                        link = f"https://www.gnb.ca{link}"

                    # Prevent duplicates from nested containers
                    if not any(h['link'] == link for h in headlines):
                        headlines.append({"title": title, "link": link})

    # Fallback that grabs real links if the exact date match breaks
    if test_date_str and not headlines:
        print(f"⚠️ Exact match failed. Grabbing top 2 headline-sized links for the test email.")
        for a_tag in soup.find_all('a'):
            title = a_tag.get_text(strip=True)
            link = a_tag.get('href')
            # Look for long strings that resemble full headlines
            if title and link and len(title.split()) > 6:
                if link.startswith('/'): link = f"https://www.gnb.ca{link}"
                if not any(h['link'] == link for h in headlines):
                    headlines.append({"title": title, "link": link})
                if len(headlines) == 2:
                    break

    return headlines


def get_subscribers(lang: str) -> List[Dict[str, str]]:
    """Retrieves and decrypts confirmed subscribers."""
    subscribers = []
    with psycopg2.connect(DB_URL) as conn:
        with conn.cursor(cursor_factory=DictCursor) as cur:
            cur.execute("SELECT encrypted_email, token FROM subscribers WHERE confirmed = TRUE AND language = %s",
                        (lang,))
            for row in cur.fetchall():
                try:
                    decrypted = decrypt_email(row['encrypted_email'])
                    subscribers.append({"email": decrypted, "token": row['token']})
                except Exception as e:
                    print(f"Failed to decrypt a subscriber record: {e}")
    return subscribers


def send_digest(headlines: List[Dict[str, str]], subscribers: List[Dict[str, str]], lang: str) -> None:
    """Sends the daily digest using Resend's batch API with email-safe inline styling."""
    if not headlines or not subscribers:
        return

    # Strictly separate the languages
    if lang == "en":
        subject = f"NB News Digest - {TARGET_DATE.strftime('%Y-%m-%d')}"
        header_title = "Today's Headlines"
        unsub_text = "Unsubscribe"
    else:
        subject = f"Résumé des nouvelles du N.-B. - {TARGET_DATE.strftime('%Y-%m-%d')}"
        header_title = "Les manchettes d'aujourd'hui"
        unsub_text = "Se désabonner"

    # Build the list of headlines
    headlines_html = ""
    for h in headlines:
        headlines_html += f"""
            <li style="margin-bottom: 14px; line-height: 1.5;">
                <a href="{h['link']}" style="color: #000; text-decoration: none; font-size: 16px; font-weight: 600;">{h['title']}</a>
            </li>
        """

    for sub in subscribers:
        unsub_link = f"{os.environ['API_URL']}/api/unsubscribe?token={sub['token']}"

        # Email-safe HTML template
        html_content = f"""
        <!DOCTYPE html>
        <html lang="{lang}">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="margin: 0; padding: 20px; background-color: #FAF8F5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #D9D3C8; border-radius: 12px; overflow: hidden;">
                <tr>
                    <td style="background-color: #0D7C72; padding: 24px; text-align: center;">
                        <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 600; letter-spacing: 0.5px;">{header_title}</h1>
                    </td>
                </tr>
                <tr>
                    <td style="padding: 32px 24px;">
                        <ul style="padding-left: 20px; margin: 0 0 32px 0; color: #1C1917;">
                            {headlines_html}
                        </ul>

                        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                            <tr>
                                <td style="border-top: 1px dashed #D9D3C8; padding-top: 20px; text-align: center;">
                                    <p style="margin: 0; font-size: 13px; color: #5C5552;">
                                        <a href="{unsub_link}" style="color: #5C5552; text-decoration: underline;">{unsub_text}</a>
                                    </p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </body>
        </html>
        """

        # IMPORTANT: Change this back to 'news@yourdomain.com' when moving to production!
        resend.Emails.send({
            "from": "news@productpassport.ca",
            "to": sub["email"],
            "subject": subject,
            "html": html_content
        })


def main() -> None:
    for lang, url in URLS.items():
        try:
            headlines = fetch_headlines(url, lang)
            if headlines:
                subs = get_subscribers(lang)
                if subs:
                    send_digest(headlines, subs, lang)
                    print(f"✅ Sent {lang} digest to {len(subs)} users.")
                else:
                    print(f"🤷‍♂️ No confirmed {lang} subscribers found in DB.")
            else:
                print(f"📭 No {lang} headlines found for {TARGET_DATE}.")
        except Exception as e:
            print(f"❌ Error processing {lang}: {e}")


if __name__ == "__main__":
    main()