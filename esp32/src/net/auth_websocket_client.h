#pragma once
#include <WebSocketsClient.h>
#include "ws_auth_recovery.h"

class AuthWebSocketsClient : public WebSocketsClient {
public:
    WsAuthRecovery authentication;
protected:
    void messageReceived(WSclient_t* client, WSopcode_t opcode, uint8_t* payload, size_t length, bool fin) override {
        if (opcode == WSop_close) authentication.closeFrame(payload, length);
        else WebSocketsClient::messageReceived(client, opcode, payload, length, fin);
    }
    void clientDisconnect(WSclient_t* client) override {
        authentication.httpStatus(client->cCode);
        WebSocketsClient::clientDisconnect(client, nullptr);
    }
};
