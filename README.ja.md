# bedrock-kb-s3vectors-rerank-rag

Amazon Bedrock Knowledge Bases と S3 Vectors、リランキングを使用した RAG（Retrieval-Augmented Generation）のサンプル CDK プロジェクトです。

[English](README.md)

## 概要

このプロジェクトは、以下の技術を使用した RAG システムの構築方法を示します：

- **Amazon Bedrock Knowledge Bases** - ドキュメントの取り込みと検索
- **Amazon S3 Vectors** - ベクトルストア（別途ベクトルデータベース不要）
- **Amazon Rerank v1** - リランキングによる検索精度の向上
- **Claude 3.5 Sonnet** - 回答生成

## アーキテクチャ

```
ドキュメント --> S3 Bucket（データソース）
                    |
              Bedrock Knowledge Base
                    |
              Titan Embedding V2 --> S3 Vectors（ベクトルストア）

クライアント --> API Gateway --> Lambda（rag_query）
                                    |
                              1. KB から検索（top_k=10）
                                    |
                              2. リランク（Amazon Rerank v1, top_n=5）
                                    |
                              3. 回答生成（Claude 3.5 Sonnet）
```

## 前提条件

- Bedrock モデルアクセスが有効な AWS アカウント
- Node.js 18+
- pnpm
- Python 3.13+
- AWS CDK CLI

## インストール

```bash
cd cdk
pnpm install
```

## デプロイ

```bash
# ブートストラップ（初回のみ）
pnpm cdk bootstrap

# デプロイ
pnpm cdk deploy
```

## 使い方

### ドキュメントのアップロード

S3 データソースバケットにドキュメントをアップロードします：

```bash
aws s3 cp your-document.pdf s3://bedrock-kb-datasource-<account-id>-<region>/
```

その後、AWS コンソールまたは CLI から Knowledge Base のデータソースを同期します。

### RAG API へのクエリ

```bash
curl -X POST https://<api-id>.execute-api.<region>.amazonaws.com/v1/query \
  -H "Content-Type: application/json" \
  -d '{
    "query": "質問内容",
    "top_k": 10,
    "top_n": 5
  }'
```

### API パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|-----------|------|---------|------|
| `query` | string | （必須） | 検索クエリ |
| `top_k` | int | 10 | KB から取得するドキュメント数 |
| `top_n` | int | 5 | リランク後に保持するドキュメント数 |

### レスポンス形式

```json
{
  "answer": "取得したドキュメントに基づく回答",
  "sources": [
    {
      "content": "関連ドキュメントの抜粋...",
      "rerank_score": 0.95,
      "location": {}
    }
  ],
  "retrieved_count": 10,
  "reranked_count": 5
}
```

## プロジェクト構成

```
cdk/
├── bin/
│   └── app.ts                              # CDK アプリエントリポイント
├── lib/
│   └── bedrock-kb-s3vectors-rerank-stack.ts # メイン CDK スタック
├── lambda/
│   └── rag_query/
│       ├── handler.py                       # RAG クエリ（リランク付き）
│       └── requirements.txt
├── package.json
├── tsconfig.json
└── cdk.json
```

## 動作の仕組み

1. **ドキュメント取り込み**: S3 にアップロードされたドキュメントをチャンク分割（512トークン、20%オーバーラップ）し、Titan Embedding V2（1024次元）でベクトル化、S3 Vectors に格納
2. **検索**: クエリを受信すると、ベクトル化して S3 Vectors から類似度の高い上位 k 件のドキュメントを検索
3. **リランキング**: Amazon Rerank v1 で検索結果をリランクし、関連度の順序を改善
4. **回答生成**: リランク後の上位 n 件のドキュメントをコンテキストとして、Claude 3.5 Sonnet が最終回答を生成

## 作成される AWS リソース

| リソース | 説明 |
|---------|------|
| S3 Bucket | ドキュメントデータソース |
| S3 Vectors Bucket | ベクトル埋め込みストア |
| Bedrock Knowledge Base | S3 Vectors を使用した RAG ナレッジベース |
| Bedrock Data Source | S3 データソース設定 |
| Lambda Function | RAG クエリハンドラー（Python 3.13） |
| API Gateway | REST API エンドポイント |
| IAM Roles | KB と Lambda 用のロール |

## ライセンス

MIT License

## コントリビュート

コントリビュートを歓迎します。お気軽に Pull Request を送ってください。
