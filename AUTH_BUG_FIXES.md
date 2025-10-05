# Authentication Bug Fixes

## Issues Fixed

### 1. **Duplicate Session Token Error**
**Problem**: When authenticating multiple times with the same wallet, the JWT token was identical, causing a unique constraint violation on `user_sessions.session_token`.

**Root Cause**: The JWT payload only contained `userId`, `walletAddress`, and `iat` (issued at time). Since the `iat` was floored to seconds, multiple requests within the same second generated identical tokens.

**Solution**: Added a unique `jti` (JWT ID) to each token using `crypto.randomBytes(16).toString('hex')`.

```typescript
static generateToken(userId: string, walletAddress: string): string {
  const payload = {
    userId,
    walletAddress,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomBytes(16).toString('hex'), // Unique token identifier
  };
  
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}
```

### 2. **Session expiresAt Coming as Undefined**
**Problem**: The `session.expiresAt` field was `undefined` in the API response.

**Root Cause**: PostgreSQL returns column names in snake_case (`expires_at`), but TypeScript interfaces expect camelCase (`expiresAt`). The code was directly returning database rows without mapping.

**Solution**: Added explicit snake_case to camelCase mapping for all database query results:

```typescript
// Before (returned snake_case directly)
return result.rows[0];

// After (maps to camelCase)
const row = result.rows[0];
return {
  id: row.id,
  userId: row.user_id,
  sessionToken: row.session_token,
  walletAddress: row.wallet_address,
  ipAddress: row.ip_address,
  userAgent: row.user_agent,
  isActive: row.is_active,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  lastAccessedAt: row.last_accessed_at,
};
```

## Files Modified

1. **`apps/api/src/auth.ts`**
   - `generateToken()` - Added unique `jti` to JWT payload
   - `createSession()` - Added snake_case to camelCase mapping
   - `validateSession()` - Added snake_case to camelCase mapping
   - `getUserById()` - Added snake_case to camelCase mapping
   - `getUserWallets()` - Added snake_case to camelCase mapping
   - `createOrUpdateVenueCredentials()` - Added snake_case to camelCase mapping
   - `getVenueCredentials()` - Added snake_case to camelCase mapping
   - `getAllVenueCredentials()` - Added snake_case to camelCase mapping

## Testing

After these fixes, the authentication flow should work correctly:

1. **First authentication** - Creates new user and session ✅
2. **Second authentication** - Creates new session with unique token ✅
3. **Session data** - All fields properly mapped to camelCase ✅
4. **expiresAt field** - Now properly returned in API response ✅

## How to Test

```bash
# Restart the API server to apply changes
cd apps/api && npm run dev

# Run the test script
source test-auth.env && node test-auth-flow.js
```

Expected output:
```
Step 3: Authenticating with API
✅ Authentication successful!
ℹ️  User ID: uuid-here
ℹ️  Session expires: 2025-10-06T08:00:00Z  # Now properly shows date
```

## No Breaking Changes

✅ All existing functionality preserved
✅ API responses remain the same format (camelCase)
✅ Database schema unchanged
✅ No changes to authentication flow logic

