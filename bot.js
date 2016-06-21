const TeleBot = require('telebot');
var https = require('https');
var Promise = require('bluebird');
var mongoose = require('mongoose');
var cfg = require('./config.js');
var fs = require('fs');
var _ = require('lodash');
var memoryLock = require('memory-lock');
var async = require('async');

const bot = new TeleBot({
    token: cfg.config.apiKey || '', // Required.
    sleep: 200, // Optional. How often check updates (in ms).
    timeout: 0, // Optional. Update pulling timeout (0 - short polling).
    limit: 100, // Optional. Limits the number of updates to be retrieved.
    retryTimeout: 5000, // Optional. Reconnecting timeout (in ms).
    modules: {

    }
});

const wordDatabase = [
  ['test1', 'test2']
];


const playersArray = [ //villager A, villager B, ghost, idiot
    null,//0
    null,//1
    [1,0,1,0],//2
    null,//3
    null,//4
    [3,1,1,0],//5
    [3,2,1,0],//6
    [4,2,1,0],//7
    [4,2,1,1],//8
    [4,2,2,1],//9
    [5,3,2,1],//10
    [6,3,2,1],//11
    [6,3,2,2],//12
];
//DB Logic

var word1 = [112668532];
var word2 = [112668532];
var readyToConfirm = [];


var mongojs = require('mongojs');
var db = mongojs('ghostgame', ['users', 'sessions']);

db.sessions.findOne({'moderator.id': 112668532}, function(err, userdocs){
   console.log(userdocs);
});

var getSession = function(chatId, callback){
    return db.sessions.findOne({chatId: chatId}, function (err, sesdocs) {
        callback(err,sesdocs);
    });
};

var getSessionModerator = function(fromId, callback){
    return db.sessions.findOne({'moderator.id': fromId}, function (err, sesdocs) {
        callback(err,sesdocs);
    });
};

var addPlayer = function(sessionId, playerData, chatId){

    db.sessions.findOne({_id: sessionId}, (err, ses) => {
        //if (playerData.id !== ses.moderator.id){
            db.sessions.findAndModify({
                query: { _id: sessionId },
                update: { $addToSet: { playersArray: playerData } },
                new: true
            }, function(err, doc, lastErrorObject)
            {
                updateSessionStatus(chatId, ses.messageId);
            });
        //}
    });
};

var startGameDB = function (chatId){
    db.sessions.findAndModify({
        query: { chatId: chatId },
        update: {
            $set: {
                started: true
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });
}

//Game Logic

var moderateNewGame = function(fromId, username, chatId){

    if (chatId >= 0)
    {
        return bot.sendMessage(fromId, "Please use this command in a group chat, so that your friends can join in the fun! \nRecommended no. of players: 5-12.");
    };

    db.users.find({id: fromId}, function (err, docs) {
        if ((docs.length) === 0){
            return bot.sendMessage(chatId, username + ", please PM me @ghostgame_bot before moderating a new game so that I can facilitate the process.");
        } else {

            var sessionLock = memoryLock({ name: chatId.toString()});

            async.series([
                function(callback){
                    var acqlock = sessionLock.writeLock(0);
                    console.log(acqlock);
                    if (acqlock){
                        return callback(null, 'acquired lock');
                    } else {
                        return callback('failed to acquire lock');
                    }
                },
                function(callback){
                    getSession(chatId, function(err, sesdocs){
                        if (sesdocs){
                            bot.sendMessage(chatId, "There already is a game ongoing in this chatgroup. Please finish it first before starting a new game.");
                            return callback(null, 'ongoing');
                        } else {

                            let sessionId;
                            db.sessions.insert({chatId: chatId}, (err,sesdocs2)=>{
                                sessionId = sesdocs2._id;
                            });

                            let markup = bot.inlineKeyboard([
                                [bot.inlineButton('Join Game', {callback: 'join'})]
                            ]);

                            bot.sendMessage(chatId, username + " has started a game! Press the button below to /join.", { markup });
                            bot.sendMessage(chatId, "<b>Moderator:</b> "+ (username || fromId) + "\n<b>Current Players: 0</b>", {parse: 'html'}).then(re => {
                               initializeJoin({
                                   fromId: fromId,
                                   username: username,
                                   chatId: chatId,
                                   messageId: re.result.message_id,
                                   sessionId: sessionId
                               });
                            });

                            initializeWords({
                                fromId: fromId,
                                username: username,
                                chatId: chatId
                            });

                            return callback(null, 'initialized');
                        }
                    });
                }
            ],
                function(err, results){
                    if (err) {
                        console.error(err);
                        return bot.sendMessage(chatId, "A game is already initializing for this group, please do not send so many requests at one time.");
                    } else {
                        sessionLock.writeUnlock();
                    }
                }
            );
        }
    });
};



var initializeJoin = function(data){
    db.sessions.findAndModify({
        query: { _id: data.sessionId },
        update: {
            $set: {
                moderator: {username: data.username, id: data.fromId},
                wordsDone: false,
                words: {word1: null, word2: null},
                playersArray: [],
                started: false,
                messageId: data.messageId
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });
};

var initializeWords = function(data){
    bot.sendMessage(data.fromId, "You are moderating a new session! Please type in the first word.", {markup: 'reply'});
    word1.push(data.fromId);
    word2.push(data.fromId);
};

var updateSessionWord1 = function(fromId, word1){
    db.sessions.findAndModify({
        query: { 'moderator.id': fromId },
        update: {
            $set: {
                'words.word1': word1
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });
};

var updateSessionWord2 = function(fromId, word2){
    db.sessions.findAndModify({
        query: { 'moderator.id': fromId },
        update: {
            $set: {
                'words.word2': word2
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });
};

var confirmSessionWords = function(fromId){
    db.sessions.findAndModify({
        query: { 'moderator.id': fromId },
        update: {
            $set: {
                wordsDone: true
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });
}

var updateSessionStatus = function (chatId, messageId){
    getSession(chatId, function(err, sesdoc){
        var playerNameString = "";

        _.forEach(sesdoc.playersArray, playerData => {
            playerNameString += ( playerData.username || playerData.firstName + " " + playerData.lastName ) + "\n";
        });

        console.log(playerNameString);

        let message = "<b>Moderator:</b> " + (sesdoc.moderator.username || sesdoc.moderator.id) +
            "\n<b>Current Players:</b> " + sesdoc.playersArray.length +
            "\n" + playerNameString;

        bot.editText({chatId, messageId}, message, {parse: 'html'});
    });
};

var updateMessageStatus = function(chatId){
    getSession(chatId, function(err, sesdoc) {

        var playerNameString = "";

        _.forEach(sesdoc.playersArray, playerData => {
            playerNameString += ( playerData.username || playerData.firstName + " " + playerData.lastName ) + "\n";
        });

        let message = "<b>Moderator:</b> " + (sesdoc.moderator.username || sesdoc.moderator.id) +
        "\n<b>Current Players:</b> " + sesdoc.playersArray.length +
        "\n" + playerNameString;

        bot.sendMessage(chatId, message, {parse: 'html'}).then(re => {
            let newMessageId = re.result.message_id;
            db.sessions.findAndModify({
                query: { chatId: chatId },
                update: {
                    $set: {
                        messageId: newMessageId
                    }
                },
            }, (err, doc, lastErrorObject) => {
                return;
            });
        })
    });
};

var startGame = function(chatId){
    getSession(chatId, (err, sesdoc) => {




    });
}

//Bot Logic

bot.on(['/start'], msg => {
    console.log(msg);

    let markup = bot.inlineKeyboard([
        [bot.inlineButton('Commands', {callback: 'commands'})],
        [bot.inlineButton('Moderate a new Game', {callback: 'moderategame'})],
        [bot.inlineButton(' ❓ How to Play', {callback: 'howtoplay'})]
    ]);

    if (msg.chat.type === 'private') {

        db.users.find({id: msg.from.id}, function(err, docs){
            if ((docs.length) > 0 ) {
                return bot.sendMessage(msg.from.id, "Hey there, you have already registered as a player of <b>Ghost</b>. Get out there and start hunting!", {parse: 'html'});
            } else {
                db.users.insert({id: msg.from.id, name: msg.from.username});
                return bot.sendMessage(msg.from.id, "Hey there, you have been successfully registered as a player of <b>Ghost</b>.", {parse: 'html'});
            }
        });

    } else {
        return bot.sendMessage(msg.chat.id, "Hey there. I'm a moderator for <b>Ghost</b>, a game of riddles and deduction for 5-12 players." +
            "\n\nPlease, tap one of the buttons below!", {parse: 'html', markup}).then(re => {console.log(re);});
    }
});

bot.on(['/join'], msg =>{
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup'){
        getSession(msg.chat.id, function(err, sesdocs){
            if (sesdocs && !sesdocs.started)
            {
                addPlayer(sesdocs._id, msg.from.username);
                updateSessionStatus(msg.message.chat.id, sesdocs.messageId);
            } else {
                return;
            }
        }) ;
    }
});

bot.on(['/status'], msg =>{
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup'){
        getSession(msg.chat.id, function(err, sesdocs){
            if (sesdocs)
            {
                updateMessageStatus(msg.chat.id);
            } else {
                bot.sendMessage(msg.chat.id, "No game is currently running in this group!");
            }
        }) ;
    }
});

bot.on(['/yes'], msg=>{
    if (_.indexOf(readyToConfirm, msg.from.id) !== -1) {
        readyToConfirm = _.without(readyToConfirm, msg.from.id);
        confirmSessionWords(msg.from.id);
    }
});

bot.on(['/no'], msg=>{
    if (_.indexOf(readyToConfirm, msg.from.id) !== -1) {
        readyToConfirm = _.without(readyToConfirm, msg.from.id);
        initializeWords({fromId: msg.from.id});
    }
});

bot.on('callbackQuery', msg => {
    console.log('------INLINE QUERY------');
    console.log(msg);

    bot.answerCallback(msg.id, '', false);

    if (msg.data === 'commands'){
        //return bot.sendMessage(msg.chat.id, "What is your <b>starting</b> location?", {parse: 'html', markup});
    } else if (msg.data === 'moderategame') {
        return moderateNewGame(msg.from.id, msg.from.username, msg.message.chat.id);
    } else if (msg.data ==='join'){
        getSession(msg.message.chat.id, function(err, sesdocs){
            if (sesdocs && !sesdocs.started)
            {
                addPlayer(sesdocs._id, {
                    firstName: msg.from.first_name,
                    lastName: msg.from.last_name,
                    id: msg.from.id,
                    username: msg.from.username
                }, msg.message.chat.id);
            } else {
                return;
            }
        }) ;
    };
    //return bot.sendMessage(msg.from.id, "Pressed the " + msg.data + " button!");
});

bot.on('text', msg => {

    //console.log(msg);
    if (_.indexOf(word1, msg.from.id) !== -1){
        updateSessionWord1(msg.from.id, msg.text);
        word1 = _.without(word1, msg.from.id);

        return bot.sendMessage(msg.from.id, 'Please type in your second word. They should be related in some manner');

    } else if (_.indexOf(word2, msg.from.id) !== -1){
        updateSessionWord2(msg.from.id, msg.text);
        word2 = _.without(word1, msg.from.id);

        readyToConfirm.push(msg.from.id);

        getSessionModerator(msg.from.id, (err, sesdoc) => {
            let w1 = sesdoc.words.word1;
            let w2 = sesdoc.words.word2;
            return bot.sendMessage.(msg.from.id, "The two words you have inputted are:\n<b>" + w1 + "</b>\n<b>" + w2 + "</b>\n\nPlease enter /yes to confirm, /no to redo.", {parse: 'html'});
        });
    };

    if (msg.text === "Manual Entry") {
        return bot.sendMessage(msg.chat.id, 'Please type in your starting location.', {markup: 'hide', ask: 'origin'});
    };
})

//Initialization
bot.connect();

