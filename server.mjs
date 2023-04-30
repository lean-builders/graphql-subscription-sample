import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { createServer } from 'http';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { PubSub, withFilter } from 'graphql-subscriptions';
import { v4 as uuid } from 'uuid';

const RESERVE_TIMEOUT = 10 * 60 * 1000; // in milliseconds

const pubSub = new PubSub();
const app = express();
const httpServer = createServer(app);

const timerMap = new Map();
const reserveMap = new Map();

const typeDefs = `#graphql
    type Reserve {
        context_id: String
        reserve_id: String
        activity_sp_id: Int
        quantity: Int
    }
    
    type Subscription {
        reserveExpired(context_id: String): Reserve
    }
    
    type Mutation {
        createReserve(context_id: String, activity_sp_id: Int, quantity: Int): Reserve
        commitReserve(reserve_id: String): Reserve
    }
    
    type Query {
        reserves: [Reserve]
    }
    
    subscription ReserveFeed {
        reserveExpired {
            context_id
            reserve_id
        }
    }
`;

const resolvers = {
    Subscription: {
        reserveExpired: {
            subscribe: withFilter(
                () => pubSub.asyncIterator(['RESERVE_EXPIRED']),
                (payload, { context_id }) => context_id === payload.context_id,
            ),
        },
    },
    Mutation: {
        createReserve: (parent, args, ctx) => {
            console.log({ parent, args, ctx });
            const reserve = {
                reserve_id: uuid(),
            };
            reserveMap.set(reserve.reserve_id, args);
            console.log( { reserveMap } );
            const timerId = setTimeout(async () => {
                if (reserveMap.has(reserve.reserve_id)) {
                    const expired = reserveMap.get(reserve.reserve_id);
                    await pubSub.publish('RESERVE_EXPIRED', {
                        context_id: args.context_id,
                        reserveExpired: reserve,
                    });
                    reserveMap.delete(args.reserve_id);
                    console.log({ expired });
                }
            }, RESERVE_TIMEOUT);
            timerMap.set(reserve.reserve_id, timerId);
            return reserve;
        },
        commitReserve: (parent, args) => {
            const reserve = reserveMap.get(args.reserve_id);
            console.log({ reserve, args });
            reserveMap.delete(args.reserve_id);
            const timerId = timerMap.get(args.reserve_id);
            clearTimeout(timerId);
            return reserve;
        }
    }
};

const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
});

const wsServer = new WebSocketServer({
    server: httpServer,
    path: '/graphql',
});

const serverCleanup = useServer(
    {
        schema,
        context: () => {
            return {};
        }
    },
    wsServer,
);

const server = new ApolloServer({
    schema,
    plugins: [
        ApolloServerPluginDrainHttpServer({ httpServer }),
        {
            async serverWillStart() {
                return {
                    async drainServer() {
                        await serverCleanup.dispose();
                    },
                };
            },
        },
    ],
});

const PORT = 4000;
const main = async () => {
    await server.start();
    app.use('/graphql', cors(), bodyParser.json(), expressMiddleware(server));
    httpServer.listen(PORT, () => {
        console.log(`Server ready at: http://localhost:${PORT}/graphql`);
    });
}

main().then(() => {
    console.log('finished');
});
