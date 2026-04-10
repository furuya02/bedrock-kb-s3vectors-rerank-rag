# bedrock-kb-s3vectors-rerank-rag

Amazon Bedrock Knowledge Bases と S3 Vectors、リランキングを使用した RAG（Retrieval-Augmented Generation）のサンプル CDK プロジェクトです。`cdk deploy` 一発で、リランク付き RAG 環境が構築できます。

[English](README.md)

## 概要

このプロジェクトは、以下の技術を使用した RAG システムの構築方法を示します：

- **Amazon Bedrock Knowledge Bases** - ドキュメントの取り込みと検索
- **Amazon S3 Vectors** - ベクトルストア（別途ベクトルデータベース不要）
- **Amazon Rerank v1** - リランキングによる検索精度の向上
- **Claude 3.5 Sonnet** - 回答生成

## アーキテクチャ


![](images/001.png)


## 前提条件

- AWS アカウント
- 以下の Bedrock モデルアクセスを有効化済み：
  - Amazon Titan Text Embeddings V2
  - Amazon Rerank v1
  - Anthropic Claude 3.5 Sonnet v2（APAC 推論プロファイル）
- Node.js 18+
- pnpm
- AWS CDK CLI

## デプロイ

```bash
git clone https://github.com/furuya02/bedrock-kb-s3vectors-rerank-rag.git
cd bedrock-kb-s3vectors-rerank-rag/cdk
pnpm install
pnpm cdk bootstrap  # 初回のみ
pnpm cdk deploy
```

デプロイが完了すると、以下が自動的に作成されます：
- S3 Vectors のベクトルバケット・インデックス
- Bedrock Knowledge Base
- S3 データソースバケット
- S3 イベントによる自動同期（Lambda）
- RAG クエリ API（Lambda + API Gateway）

## 使い方

### 1. ドキュメントのアップロード

デプロイ出力の `DataSourceBucketName` に表示される S3 バケットにドキュメントをアップロードします。サンプルデータも同梱しています。

```bash
aws s3 sync sample_data/ s3://<DataSourceBucketName>/
```

S3 へのファイル追加・削除時に、Knowledge Base の同期が自動的に実行されます。同期完了まで1〜2分お待ちください。

### 2. クエリの実行

デプロイ出力に表示される `QueryEndpoint` を使用してクエリを実行します。

```bash
curl -X POST <QueryEndpoint> \
  -H "Content-Type: application/json" \
  -d '{"query": "S3 Vectorsとは何ですか？"}'
```

### サンプルクエリ

```bash
# S3 Vectorsについて
curl -X POST <QueryEndpoint> \
  -H "Content-Type: application/json" \
  -d '{"query": "S3 Vectorsとは何ですか？"}'

# リランキングの仕組み
curl -X POST <QueryEndpoint> \
  -H "Content-Type: application/json" \
  -d '{"query": "リランキングの仕組みを教えてください"}'

# Lambdaのメモリ制限
curl -X POST <QueryEndpoint> \
  -H "Content-Type: application/json" \
  -d '{"query": "Lambdaのメモリ制限はいくつですか？"}'
```

### ドキュメントの追加

S3 バケットにドキュメントを追加すると、自動的に Knowledge Base の同期が実行されます。

```bash
aws s3 cp your-document.txt s3://<DataSourceBucketName>/
```

ドキュメントの削除時も自動的に同期されます。

### リランクの動作確認（CloudWatch Logs）

Bedrock のモデル呼び出しログを有効にすると、リランクの入力（ベクトル検索でヒットしたドキュメント）と出力（`relevance_score` による再評価結果）を CloudWatch Logs で確認できます。

**ログの有効化:**

Bedrock コンソール → Settings → Model invocation logging → CloudWatch Logs を有効化

**ログの確認:**

```bash
aws logs filter-log-events \
  --log-group-name /aws/bedrock/model-invocation-logs \
  --filter-pattern '"amazon.rerank"' \
  --region ap-northeast-1 \
  --query "events[].message" --output text
```

ログには以下の情報が記録されます：

- **inputBodyJson**: ベクトル検索でヒットしたドキュメント一覧（`documents`）とクエリ（`query`）
- **outputBodyJson**: 各ドキュメントの `relevance_score`（リランク後のスコア）と `index`（元のドキュメントの位置）

```json
{
  "operation": "InvokeModel",
  "modelId": "arn:aws:bedrock:...foundation-model/amazon.rerank-v1:0",
  "input": {
    "inputBodyJson": {
      "documents": ["ドキュメント1...", "ドキュメント2...", ...],
      "query": "S3 Vectorsとは何ですか？"
    }
  },
  "output": {
    "outputBodyJson": {
      "results": [
        {"index": 0, "relevance_score": 0.9604},
        {"index": 3, "relevance_score": 0.0062},
        ...
      ]
    }
  }
}
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
│   ├── rag_query/
│   │   ├── handler.py                       # RAG クエリ（リランク付き）
│   │   └── requirements.txt
│   └── sync_trigger/
│       └── handler.py                       # S3 イベントで KB 自動同期
├── package.json
├── tsconfig.json
└── cdk.json
sample_data/                                 # テスト用サンプルドキュメント（自動アップロード）
```

## 動作の仕組み

1. **ドキュメント取り込み**: S3 にアップロードされたドキュメントをチャンク分割（512トークン、20%オーバーラップ）し、Titan Embedding V2（1024次元）でベクトル化、S3 Vectors に格納
2. **自動同期**: S3 バケットへのファイル追加・削除を検知し、Lambda 経由で自動的にインジェストジョブを開始
3. **検索**: クエリを受信すると、ベクトル化して S3 Vectors から類似度の高い上位 k 件のドキュメントを検索
4. **リランキング**: Amazon Rerank v1 で検索結果をリランクし、関連度の順序を改善
5. **回答生成**: リランク後の上位 n 件のドキュメントをコンテキストとして、Claude 3.5 Sonnet が最終回答を生成

## 作成される AWS リソース

| リソース | 説明 |
|---------|------|
| S3 Bucket | ドキュメントデータソース |
| S3 Vectors（Custom Resource） | ベクトルバケットとインデックス |
| Bedrock Knowledge Base | S3 Vectors を使用した RAG ナレッジベース |
| Bedrock Data Source | S3 データソース設定 |
| Lambda Function（rag_query） | RAG クエリハンドラー（Python 3.13） |
| Lambda Function（sync_trigger） | S3 イベントで KB 自動同期 |
| API Gateway | REST API エンドポイント |
| IAM Roles | KB と Lambda 用のロール |

## 設定

プロジェクト名は `cdk/cdk.json` で設定されています：

```json
{
  "context": {
    "projectName": "bedrock-kb-s3vectors-rerank-rag"
  }
}
```

この値が全リソース名のプレフィックスとして使用されます。

## クリーンアップ

```bash
pnpm cdk destroy
```

## ライセンス

MIT License

## コントリビュート

コントリビュートを歓迎します。お気軽に Pull Request を送ってください。
