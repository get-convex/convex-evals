# Convex Eval Scores

This folder contains a Convex application for storing and managing evaluation scores for different models.

## Getting Started

1. Run the Convex development server:
   ```
   npx convex dev
   ```

2. Create an authentication token using the Convex dashboard or via the API.

## API Usage

### Authentication

All API endpoints require authentication using a bearer token. To create a token:

1. Using the Convex dashboard, call the `auth:createToken` function with a name parameter:
   ```
   {
     "name": "my-token-name"
   }
   ```

2. Save the returned token value in a secure place. This is the only time you'll see the full token value.

3. When making requests to the API, include the token in the Authorization header:
   ```
   Authorization: Bearer <token-value>
   ```

### Endpoints

#### POST /api/updateScores

Updates the scores for a specific model.

**Request:**
```json
{
  "model": "gpt-4o",
  "scores": {
    "fundamentals": 0.95,
    "data_modeling": 0.87,
    "queries": 0.92
  }
}
```

**Response:**
```json
{
  "success": true,
  "id": "id-of-the-updated-record"
}
```

## Python Integration

Set the following environment variables to enable automatic submission of scores:

```
CONVEX_EVAL_ENDPOINT=https://your-convex-deployment.convex.site/api/updateScores
CONVEX_AUTH_TOKEN=your-auth-token-value
```

The evaluation script will then automatically submit results to your Convex deployment.

## Token Management

The system includes several functions for managing authentication tokens:

- `createToken`: Creates a new token with a given name
- `listTokens`: Lists all token names (but not their values)
- `deleteToken`: Deletes a token by ID

For security reasons, token values are never returned after initial creation.