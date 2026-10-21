# 04 — Database & REST API

## 1. MySQL Schema

```sql
CREATE TABLE users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  number        CHAR(10) NOT NULL UNIQUE,          -- virtual number
  token_hash    CHAR(64) NOT NULL,                 -- sha256(token); never store raw token
  name          VARCHAR(50) DEFAULT 'Guest',
  avatar        VARCHAR(255) NULL,
  password_hash VARCHAR(255) NULL,                 -- only if user registers
  is_banned     TINYINT(1) DEFAULT 0,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen     TIMESTAMP NULL,
  INDEX (token_hash)
);

CREATE TABLE messages (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  from_number   CHAR(10) NOT NULL,
  to_number     CHAR(10) NOT NULL,
  body          TEXT NOT NULL,
  status        ENUM('sent','delivered','read') DEFAULT 'sent',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pair (from_number, to_number, id),
  INDEX idx_to_status (to_number, status)
);

CREATE TABLE calls (
  id            CHAR(36) PRIMARY KEY,              -- callId uuid
  from_number   CHAR(10) NOT NULL,
  to_number     CHAR(10) NOT NULL,
  is_video      TINYINT(1) DEFAULT 0,
  status        ENUM('completed','missed','rejected','cancelled','failed') NOT NULL,
  started_at    TIMESTAMP NULL,                    -- when ringing started
  answered_at   TIMESTAMP NULL,
  ended_at      TIMESTAMP NULL,
  duration_sec  INT DEFAULT 0,
  INDEX (from_number), INDEX (to_number)
);

CREATE TABLE contacts (
  owner_number  CHAR(10) NOT NULL,
  contact_number CHAR(10) NOT NULL,
  nickname      VARCHAR(50),
  PRIMARY KEY (owner_number, contact_number)
);

CREATE TABLE blocks (
  owner_number  CHAR(10) NOT NULL,
  blocked_number CHAR(10) NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_number, blocked_number)
);
```

## 2. Virtual Number Rules

- 10 digits, first digit 1–9, generated with `crypto.randomInt`.
- Insert inside a loop; if MySQL returns duplicate-key error, regenerate (handles race conditions).
- Optional: avoid easy-to-guess sequences (`1111111111`, `1234567890`) to reduce prank calls.
- Optional prefix for branding, e.g. every number starts with `88` → 8 random digits remaining.

## 3. Token Rules

- On identity creation: `token = crypto.randomBytes(32).toString('hex')`.
- Return raw token **once** to client; store only `sha256(token)` in DB.
- Client keeps it in `localStorage`. Anyone with the token can act as that number → treat as password.
- Optional: "Recovery" — user sets name + password, so on a new device they log in with number + password and receive a fresh token.

## 4. REST Endpoints

Base: `/api` (JSON)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/identity` | none (rate-limited by IP) | Create new user → `{number, token}` |
| POST | `/login` | none | `{number, password}` → `{token}` (recovery) |
| POST | `/register` | token | Set name + password for current number |
| GET | `/me` | token | Profile |
| PUT | `/me` | token | Update name/avatar |
| GET | `/ice` | token | Short-lived ICE/TURN credentials |
| GET | `/lookup/:number` | token | `{exists, name, status}` for dialpad validation |
| GET | `/calls?limit=50` | token | Call history |
| GET | `/chats` | token | Recent conversations list with last message + unread count |
| GET | `/messages/:number?beforeId=&limit=30` | token | Chat history |
| GET | `/contacts` | token | Saved contacts |
| POST | `/contacts` | token | `{number, nickname}` |
| DELETE | `/contacts/:number` | token | Remove |
| POST | `/block` | token | `{number}` |
| DELETE | `/block/:number` | token | Unblock |

Auth header: `Authorization: Bearer <token>`.

### Example: POST /api/identity
Response `201`
```json
{ "number": "7384920155", "token": "9f2c...e1", "name": "Guest" }
```

### Example: GET /api/lookup/9911223344
```json
{ "exists": true, "name": "Amit", "status": "online" }
```

## 5. TURN Credentials (time-limited, coturn `use-auth-secret`)

```js
function turnCreds(number){
  const expiry = Math.floor(Date.now()/1000) + 3600;
  const username = `${expiry}:${number}`;
  const credential = crypto.createHmac('sha1', process.env.TURN_SECRET)
                           .update(username).digest('base64');
  return { username, credential };
}
```

## 6. Data Retention

- Messages: keep 90 days (cron cleanup) or forever if you want history.
- Calls: keep 1 year.
- Inactive guest users (no login 180 days): delete number and recycle.
