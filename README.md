# bedrock-kb-s3vectors-rerank-rag

A sample CDK project that implements RAG (Retrieval-Augmented Generation) using Amazon Bedrock Knowledge Bases with S3 Vectors and Reranking.

[Japanese (日本語)](README.ja.md)

## Overview

This project demonstrates how to build a RAG system using:

- **Amazon Bedrock Knowledge Bases** for document ingestion and retrieval
- **Amazon S3 Vectors** as the vector store (no separate vector database required)
- **Amazon Rerank v1** for improving search relevance through reranking
- **Claude 3.5 Sonnet** for answer generation

## Architecture

```
Documents --> S3 Bucket (Data Source)
                    |
              Bedrock Knowledge Base
                    |
              Titan Embedding V2 --> S3 Vectors (Vector Store)

Client --> API Gateway --> Lambda (rag_query)
                              |
                        1. Retrieve from KB (top_k=10)
                              |
                        2. Rerank (Amazon Rerank v1, top_n=5)
                              |
                        3. Generate Answer (Claude 3.5 Sonnet)
```

## Prerequisites

- AWS Account with Bedrock model access enabled
- Node.js 18+
- pnpm
- Python 3.13+
- AWS CDK CLI

## Installation

```bash
cd cdk
pnpm install
```

## Deployment

```bash
# Bootstrap (first time only)
pnpm cdk bootstrap

# Deploy
pnpm cdk deploy
```

## Usage

### Upload Documents

Upload documents to the S3 data source bucket:

```bash
aws s3 cp your-document.pdf s3://bedrock-kb-datasource-<account-id>-<region>/
```

Then sync the Knowledge Base data source from the AWS Console or CLI.

### Query the RAG API

```bash
curl -X POST https://<api-id>.execute-api.<region>.amazonaws.com/v1/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Your question here",
    "top_k": 10,
    "top_n": 5
  }'
```

### API Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | (required) | The search query |
| `top_k` | int | 10 | Number of documents to retrieve from KB |
| `top_n` | int | 5 | Number of documents to keep after reranking |

### Response Format

```json
{
  "answer": "Generated answer based on retrieved documents",
  "sources": [
    {
      "content": "Relevant document excerpt...",
      "rerank_score": 0.95,
      "location": {}
    }
  ],
  "retrieved_count": 10,
  "reranked_count": 5
}
```

## Project Structure

```
cdk/
├── bin/
│   └── app.ts                              # CDK app entry point
├── lib/
│   └── bedrock-kb-s3vectors-rerank-stack.ts # Main CDK stack
├── lambda/
│   └── rag_query/
│       ├── handler.py                       # RAG query with reranking
│       └── requirements.txt
├── package.json
├── tsconfig.json
└── cdk.json
```

## How It Works

1. **Document Ingestion**: Documents uploaded to S3 are chunked (512 tokens, 20% overlap) and embedded using Titan Embedding V2 (1024 dimensions), then stored in S3 Vectors
2. **Retrieval**: When a query is received, it is embedded and used to search the S3 Vectors store for the top-k most similar documents
3. **Reranking**: Retrieved documents are reranked using Amazon Rerank v1 to improve relevance ordering
4. **Generation**: The top-n reranked documents are used as context for Claude 3.5 Sonnet to generate a final answer

## AWS Resources Created

| Resource | Description |
|----------|-------------|
| S3 Bucket | Document data source |
| S3 Vectors Bucket | Vector embeddings store |
| Bedrock Knowledge Base | RAG knowledge base with S3 Vectors |
| Bedrock Data Source | S3 data source configuration |
| Lambda Function | RAG query handler (Python 3.13) |
| API Gateway | REST API endpoint |
| IAM Roles | Roles for KB and Lambda |

## License

MIT License

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
