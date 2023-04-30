# graphql-subscription-sample
an example for GraphQL Subscription

## 概要

サブスクリプションを使って、予約したトランザクションが一定時間内にcommitされたなかったとき、abortさせる。

## サーバ(`server.js`)

```shell
yarn start
```

### スキーマ

typeDefsにGraphQLのスキーマがある。

```graphql
    type Reserve {
        context_id: String
        reserve_id: String
        activity_sp_id: Int
        quantity: Int
    }
```

予約に含まれるプロパティの名前と型と宣言している。

(GraphQLのメリットとして、引数や戻り値の型を宣言できることがある。)

```graphql
    type Subscription {
        reserveExpired(context_id: String): Reserve
    }
```

サブスクリプションのトリガー `reserveExpired` の引数と戻り値(購読で得られるメッセージ)の型を宣言している。

`reserveExpired`には、クライアントサイドで作ったUUIDを `context_id` として渡す。
これは、サブスクリプションとミューテーションを対応づけるための工夫である。

```graphql
    type Mutation {
        createReserve(context_id: String, activity_sp_id: Int, quantity: Int): Reserve
        commitReserve(reserve_id: String): Reserve
    }
```

ミューテーション `createReserve` と `commitReserve` の引数と戻り値の型を宣言している。

`createReserve` は、 `context_id` において、
`activity_sp_id` で示される商材を
`quantity` で示される個数、購入するための予約を作成する。

`commitReserve` は、 `createReserve` で作成した予約の決済の完了時に、
予約確定をデータベースに反映させる。

```graphql
    type Query {
        reserves: [Reserve]
    }
```

これは実は意味のない宣言である。

GraphQLでは、クエリを未定義することが許可されていないので、仕方なく意味のない宣言を記述している。


```graphql
    subscription ReserveFeed {
        reserveExpired {
            context_id
            reserve_id
        }
    }
```

サブスクリプション `ReserveFeed` においてトリガー `reserveExpired` において、
プロパティ `context_id` と `reserve_id` を購読することを宣言している。

### リゾルバ

resolversにリゾルバの定義がある。

```js
Subscription: {
    reserveExpired: {
        subscribe: withFilter(
            () => pubSub.asyncIterator(['RESERVE_EXPIRED']),
            (payload, { context_id }) => context_id === payload.context_id,
        ),
    },
}
```

トリガー `reserveExpired` を購読する処理を記述している。

ここでは、サブスクリプションの接続時に与えられた `context_id` と、
イベントペイロードのプロパティ `context_id` が一致している場合のみ、
そのイベントをクライアントに送信することを表現している。

`pubSub` は `graphql-subscriptions` の提供する `PubSub` クラスのインスタンスであるが、
このクラスはサンプルコード用のものであって、本番では使わないようにせよ、とドキュメントに書かれている。
要するに擬似的なメッセージングシステムのクライアントだと思えば良い。

ここでは `asyncIterator` を用いて、トピック `RESERVE_EXPIRED` に新しいメッセージが届くと、
リアクティヴに `subscribe` 処理が走ると思えば良い。

```js
Mutation: {
    createReserve: (parent, args, ctx) => {
        const reserve = {
            reserve_id: uuid(),
        };
        reserveMap.set(reserve.reserve_id, args);
        const timerId = setTimeout(async () => {
            if (reserveMap.has(reserve.reserve_id)) {
                const expired = reserveMap.get(reserve.reserve_id);
                await pubSub.publish('RESERVE_EXPIRED', {
                    context_id: args.context_id,
                    reserveExpired: reserve,
                });
                reserveMap.delete(args.reserve_id);
            }
        }, RESERVE_TIMEOUT);
        timerMap.set(reserve.reserve_id, timerId);
        return reserve;
    },
    commitReserve: (parent, args) => {
        const reserve = reserveMap.get(args.reserve_id);
        reserveMap.delete(args.reserve_id);
        const timerId = timerMap.get(args.reserve_id);
        clearTimeout(timerId);
        return reserve;
    }
}
```

ミューテーション側は2つ関数を定義している。

#### createReserve

1. 戻り値(クライアントに送信するオブジェクト)として `reserve` を作る。
   1. `reserve.reserve_id` に、UUIDを生成して、付与する。
2. `reserveMap` のキー `reserve.reserve_id` に、クライアントから渡されたオブジェクト `args` をセットする。
   1. これはAWS DynamoDBに値をセットする処理を模したものである。
3. タイマーをセットする。
   1. `RESERVE_TIMEOUT` ミリ秒後に実行する。
   2. `reserveMap` にキー `reserve.reserve_id` の値が残っているなら...
      1. その値の `context_id` と `reserve_id` トピック `RESERVE_EXPIRED` にpublishする。
         1. 要するにサブスクリプションを通じて、クライアントにキャンセルされた予約の予約IDを通知する。
      2. `reserveMap` からキー `reserve.reserve_id` のエントリを削除する。
4. `timerMap` のキー `reserve.reserve_id` に、上記3で作ったタイマーのIDをセットする。
   1. 予約のコミット時に、もうキャンセルの必要がなくなったタイマーをクリアするため。
5. reserveを返す。
   1. すなわちクライアントに予約IDを伝える。

#### commitReserve

1. `reserveMap` から、クライアントから渡された予約IDに対応する値を取得して `reserve` と置く。
   1. DynamoDBから予約をgetするイメージ。
   2. 本来はここで注文をコミットする。
2. `reserveMap` から当該エントリを削除する。
3. `timerMap` から予約IDに対応するタイマーIDを取得し、そのタイマーをクリアする。
4. `reserve` を返す。
    1. すなわちクライアントにコミットに成功した予約の詳細を伝える。

## クライアント(`test.js`)

```shell
yarn test
```

### link

```js
const httpLink = new HttpLink({
    uri: 'http://localhost:4000/graphql',
});

const wsLink = new GraphQLWsLink(
    createClient({
        url: 'ws://localhost:4000/graphql',
        webSocketImpl: WebSocket
    })
);

const link = split(
    ({ query }) => {
        const definition = getMainDefinition(query);
        return definition.kind === 'OperationDefinition' && definition.operation === 'subscription';
    },
    wsLink,
    httpLink,
);
```

GraphQLは、通常のクエリ/ミューテーションにHTTPを使い、サブスクリプションにはWebSocketを使う。

ここのコードは、両者を使い分けるためのボイラープレートコードである。

### サブスクリプション

```js
const contextId = uuid();

const RESERVE_SUBSCRIPTION = gql`
    subscription ReserveFeed($contextId: String) {
        reserveExpired(context_id: $contextId) {
            reserve_id
        }
    }
`;

client.subscribe({
    query: RESERVE_SUBSCRIPTION,
    variables: {
        contextId,
    },
}).subscribe({
    next({ data }) {
        console.log({ data });
        // キャンセルされた予約の処理をここに書く。
    },
    error(err) {
        console.error(err);
    },
});
```

`RESERVE_SUBSCRIPTION` に購読するサブスクリプションを獲得するクエリを定義している。
変数 `contextId` を通じて、 `reserveExpired` に引数 `context_id` を渡して、 `reserve_id` を購読する。

### ミューテーション

```js
// create 1st reserve
client.mutate({
    mutation: MUTATION_CREATE_RESERVE,
    variables: {
        contextId,
        activitySpId,
        quantity,
    }
}).then(({ data }) => {
    const reserveId = data.createReserve.reserve_id;
```

まず1つ目の予約を作成する。

結果の中に予約IDがある。

```js
    // commit 1st reserve
    client.mutate({
        mutation: MUTATION_COMMIT_RESERVE,
        variables: {
            reserveId,
        }
    }).then(({ data }) => {
        console.log(`context_id: ${contextId} === ${data.commitReserve.context_id} => ${contextId === data.commitReserve.context_id}`);
        console.log(`activity_sp_id: ${activitySpId} === ${data.commitReserve.activity_sp_id} => ${activitySpId === data.commitReserve.activity_sp_id}`);
        console.log(`quantity: ${quantity} === ${data.commitReserve.quantity} => ${quantity === data.commitReserve.quantity}`);
```

1つ目の予約をコミットし、その戻り値が、予約時のデータと一致することを確認している。

(カートから取り除くべき注文を確認しているイメージ。)

```js
        // create 2nd reserve
        client.mutate({
            mutation: MUTATION_CREATE_RESERVE,
            variables: {
                contextId,
                activitySpId,
                quantity,
            }
        }).then(async ({ data }) => {
            const reserveId = data.createReserve.reserve_id;
            console.log({ reserveId });
            const wait = new Promise((resolve) => {
                setTimeout(() => {
                    resolve()
                }, RESERVE_TIMEOUT + 1000);
            })
            wait.then(() => {
               console.log('finished');
            });
        });
```

2つ目の予約を入れた後、受信した予約IDを印字し、
その後、予約がキャンセルされるのを待つ。

