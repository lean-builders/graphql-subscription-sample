const { ApolloClient, InMemoryCache, HttpLink, split, gql} = require('@apollo/client/core');
const { GraphQLWsLink } = require('@apollo/client/link/subscriptions');
const { createClient } = require('graphql-ws');
const { getMainDefinition } = require('@apollo/client/utilities');
const WebSocket = require('ws');
const { v4: uuid } = require('uuid');

const RESERVE_TIMEOUT = 10 * 60 * 1000; // in milliseconds

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

const client = new ApolloClient({
    link,
    cache: new InMemoryCache(),
});

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

const MUTATION_CREATE_RESERVE = gql`
    mutation CreateReserve($contextId: String, $activitySpId: Int, $quantity: Int) {
        createReserve(context_id: $contextId, activity_sp_id: $activitySpId, quantity: $quantity) {
            reserve_id
        }
    }
`

const MUTATION_COMMIT_RESERVE = gql`
    mutation CommitReserve($reserveId: String) {
        commitReserve(reserve_id: $reserveId) {
            context_id
            activity_sp_id
            quantity
        }
    }
`

const activitySpId = 101;
const quantity = 1;

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
    });
});

