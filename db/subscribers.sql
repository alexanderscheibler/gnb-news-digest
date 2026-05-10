CREATE TABLE subscribers (
    id SERIAL PRIMARY KEY,
    email_hash VARCHAR(64) UNIQUE NOT NULL,    -- SHA-256 blind index for ON CONFLICT
    encrypted_email TEXT NOT NULL,             -- base64(nonce + ciphertext + auth_tag)
    language VARCHAR(2) NOT NULL CHECK (language IN ('en', 'fr')),
    confirmed BOOLEAN DEFAULT FALSE,
    token UUID DEFAULT uuid_generate_v4(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);