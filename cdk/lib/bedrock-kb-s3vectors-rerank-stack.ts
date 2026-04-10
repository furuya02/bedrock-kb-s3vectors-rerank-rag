import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export class BedrockKbS3VectorsRerankStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = this.region;
    const accountId = this.account;
    const projectName = this.node.tryGetContext("projectName");
    const shortName = "bk-s3v-rerank";

    // ========================================
    // S3 Bucket: ドキュメントデータソース
    // ========================================
    const dataBucket = new s3.Bucket(this, "DataSourceBucket", {
      bucketName: `${shortName}-datasource-${accountId}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ========================================
    // S3 Vectors: ベクトルバケット & インデックス
    // ========================================
    const vectorBucketName = `${shortName}-vectors-${accountId}`;
    const vectorIndexName = `${projectName}-index`;

    // S3 Vectors ベクトルバケットを作成
    const createVectorBucket = new cr.AwsCustomResource(
      this,
      "CreateVectorBucket",
      {
        onCreate: {
          service: "S3Vectors",
          action: "createVectorBucket",
          parameters: {
            vectorBucketName: vectorBucketName,
          },
          physicalResourceId: cr.PhysicalResourceId.of(vectorBucketName),
        },
        onDelete: {
          service: "S3Vectors",
          action: "deleteVectorBucket",
          parameters: {
            vectorBucketName: vectorBucketName,
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              "s3vectors:CreateVectorBucket",
              "s3vectors:DeleteVectorBucket",
            ],
            resources: [
              `arn:aws:s3vectors:${region}:${accountId}:bucket/${vectorBucketName}`,
              `arn:aws:s3vectors:${region}:${accountId}:bucket/*`,
            ],
          }),
        ]),
      }
    );

    // S3 Vectors ベクトルインデックスを作成
    const createVectorIndex = new cr.AwsCustomResource(
      this,
      "CreateVectorIndex",
      {
        onCreate: {
          service: "S3Vectors",
          action: "createIndex",
          parameters: {
            vectorBucketName: vectorBucketName,
            indexName: vectorIndexName,
            dimension: 1024,
            distanceMetric: "cosine",
            dataType: "float32",
            metadataConfiguration: {
              nonFilterableMetadataKeys: [
                "AMAZON_BEDROCK_TEXT_CHUNK",
                "AMAZON_BEDROCK_METADATA",
              ],
            },
          },
          physicalResourceId: cr.PhysicalResourceId.of(
            `${vectorBucketName}/${vectorIndexName}`
          ),
        },
        onDelete: {
          service: "S3Vectors",
          action: "deleteIndex",
          parameters: {
            vectorBucketName: vectorBucketName,
            indexName: vectorIndexName,
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              "s3vectors:CreateIndex",
              "s3vectors:DeleteIndex",
            ],
            resources: [
              `arn:aws:s3vectors:${region}:${accountId}:bucket/${vectorBucketName}`,
              `arn:aws:s3vectors:${region}:${accountId}:bucket/${vectorBucketName}/index/*`,
            ],
          }),
        ]),
      }
    );

    createVectorIndex.node.addDependency(createVectorBucket);

    const vectorIndexArn = `arn:aws:s3vectors:${region}:${accountId}:bucket/${vectorBucketName}/index/${vectorIndexName}`;

    // ========================================
    // IAM Role: Bedrock Knowledge Base 用
    // ========================================
    const kbRole = new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description: `Role for ${projectName} Knowledge Base`,
    });

    // データソース S3 へのアクセス権限
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [dataBucket.bucketArn, `${dataBucket.bucketArn}/*`],
      })
    );

    // S3 Vectors へのアクセス権限
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3vectors:*"],
        resources: [
          `arn:aws:s3vectors:${region}:${accountId}:bucket/*`,
        ],
      })
    );

    // Bedrock Embedding モデルへのアクセス権限
    kbRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
        ],
      })
    );

    // ========================================
    // Bedrock Knowledge Base
    // ========================================
    const knowledgeBase = new bedrock.CfnKnowledgeBase(
      this,
      "KnowledgeBase",
      {
        name: projectName,
        description: `${projectName} - Bedrock Knowledge Base with S3 Vectors and Reranking`,
        roleArn: kbRole.roleArn,
        knowledgeBaseConfiguration: {
          type: "VECTOR",
          vectorKnowledgeBaseConfiguration: {
            embeddingModelArn: `arn:aws:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
            embeddingModelConfiguration: {
              bedrockEmbeddingModelConfiguration: {
                dimensions: 1024,
              },
            },
          },
        },
        storageConfiguration: {
          type: "S3_VECTORS",
          s3VectorsConfiguration: {
            indexArn: vectorIndexArn,
          },
        },
      }
    );

    knowledgeBase.node.addDependency(kbRole);
    knowledgeBase.node.addDependency(createVectorIndex);

    // ========================================
    // Bedrock Data Source
    // ========================================
    const dataSource = new bedrock.CfnDataSource(this, "DataSource", {
      name: `${projectName}-s3-data-source`,
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: {
          bucketArn: dataBucket.bucketArn,
        },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "FIXED_SIZE",
          fixedSizeChunkingConfiguration: {
            maxTokens: 512,
            overlapPercentage: 20,
          },
        },
      },
    });

    // ========================================
    // S3 イベントによる自動同期
    // ========================================
    const syncTriggerLambda = new lambda.Function(
      this,
      "SyncTriggerFunction",
      {
        functionName: `${projectName}-sync-trigger`,
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: "handler.lambda_handler",
        code: lambda.Code.fromAsset("lambda/sync_trigger"),
        timeout: cdk.Duration.seconds(10),
        memorySize: 128,
        environment: {
          KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
          DATA_SOURCE_ID: dataSource.attrDataSourceId,
          REGION: region,
        },
      }
    );

    syncTriggerLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:StartIngestionJob"],
        resources: [knowledgeBase.attrKnowledgeBaseArn],
      })
    );

    dataBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(syncTriggerLambda)
    );
    dataBucket.addEventNotification(
      s3.EventType.OBJECT_REMOVED,
      new s3n.LambdaDestination(syncTriggerLambda)
    );

    // ========================================
    // Lambda: RAG クエリ（リランク付き）
    // ========================================
    const ragQueryLambda = new lambda.Function(this, "RagQueryFunction", {
      functionName: `${projectName}-rag-query`,
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: "handler.lambda_handler",
      code: lambda.Code.fromAsset("lambda/rag_query"),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        KNOWLEDGE_BASE_ID: knowledgeBase.attrKnowledgeBaseId,
        RERANK_MODEL_ID: "amazon.rerank-v1:0",
        GENERATION_MODEL_ID:
          "apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
        REGION: region,
      },
    });

    // Lambda に Bedrock へのアクセス権限を付与
    ragQueryLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:Retrieve",
          "bedrock:RetrieveAndGenerate",
          "bedrock:InvokeModel",
        ],
        resources: [
          knowledgeBase.attrKnowledgeBaseArn,
          `arn:aws:bedrock:${region}::foundation-model/amazon.rerank-v1:0`,
          `arn:aws:bedrock:${region}:${accountId}:inference-profile/apac.anthropic.claude-3-5-sonnet-20241022-v2:0`,
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
        ],
      })
    );

    // Lambda に Rerank アクセス権限を付与
    ragQueryLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:Rerank"],
        resources: ["*"],
      })
    );

    // ========================================
    // API Gateway
    // ========================================
    const api = new apigateway.RestApi(this, "RagApi", {
      restApiName: `${projectName}-api`,
      description: `${projectName} - API for Bedrock Knowledge Base RAG with Reranking`,
      deployOptions: {
        stageName: "prod",
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const queryResource = api.root.addResource("query");
    queryResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(ragQueryLambda)
    );

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, "KnowledgeBaseId", {
      value: knowledgeBase.attrKnowledgeBaseId,
      description: "Bedrock Knowledge Base ID",
    });

    new cdk.CfnOutput(this, "DataSourceId", {
      value: dataSource.attrDataSourceId,
      description: "Bedrock Data Source ID",
    });

    new cdk.CfnOutput(this, "DataSourceBucketName", {
      value: dataBucket.bucketName,
      description: "S3 Data Source Bucket Name",
    });

    new cdk.CfnOutput(this, "QueryEndpoint", {
      value: `${api.url}query`,
      description: "RAG Query Endpoint",
    });
  }
}
