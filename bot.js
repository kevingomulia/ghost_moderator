const TeleBot = require('telebot');
var https = require('https');
var Promise = require('bluebird');
var mongoose = require('mongoose');
var cfg = require('./config.js');
var fs = require('fs');
var _ = require('lodash');
var memoryLock = require('memory-lock');
var async = require('async');
var rotate = require('rotate-array');

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

const dummyNames = [
    {firstName: 'dummyplayer1',
    lastName: 'dunce',
    id: 123,
    username: 'dp1' },
    {firstName: 'dummyplayer2',
        lastName: 'doink',
        id: 124,
        username: 'dp2'},
    {firstName: 'dummyplayer3',
        lastName: 'dimple',
        id: 125,
        username: 'dp3'},
    {firstName: 'dummyplayer4',
        lastName: 'domce',
        id: 126,
        username: 'dp4'},
    {firstName: 'dummyplayer5',
        lastName: 'dimdum',
        id: 127,
        username: 'dp5'}
];

const gamePlayersArray = [ //villager A, villager B, ghost, idiot
    null,//0
    null,//1
    [1,0,1,0],//2
    null,//3
    [2,1,1,0],//4
    [3,1,1,0],//5
    [3,2,1,0],//6
    [4,2,1,0],//7
    [4,2,1,1],//8
    [4,2,2,1],//9
    [5,3,2,1],//10
    [6,3,2,1],//11
    [6,3,2,2],//12
];

const sessionRegex = /([-]\d+)[.](\d+)/;
const voteRegex = /([-]\d+)[.][v][.](\d+)/;
//DB Logic

var word1 = [];
var word2 = [];
var readyToConfirm = [];

var canVote = {};
var canGhost = {};

var toAnswer= {};
var gameInSession = {};
var toVote= {};

var mongojs = require('mongojs');
var db = mongojs('ghostgame', ['users', 'sessions']);

var chatId = (-52762427).toString() + '.role';


var getSession = function(chatId, callback){
    return db.sessions.findOne({chatId: chatId}, function (err, sesdocs) {
        callback(err,sesdocs);
    });
};

getSession(-52762427, (err,sesdoc)=>{
    console.log(sesdoc)
})

var getSessionModerator = function(fromId, callback){
    return db.sessions.findOne({'moderator.id': fromId}, function (err, sesdocs) {
        callback(err,sesdocs);
    });
};

var getUser = function(userId, callback){
    return db.users.findOne({id: userId}, function (err, userdocs) {
        callback(err,userdocs);
    });
};

var getUserByRole = function(chatId, role, callback){
    let queryString = chatId.toString() + '.role';

    return db.users.findOne({[queryString]: role}, function (err, userdocs) {
        callback(err,userdocs);
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
                updateSessionStatus(chatId);
            });
        //};
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
        updateSessionStatus(doc.chatId);
    });
};

var updateSessionStatus = function (chatId){
    getSession(chatId, function(err, sesdoc){
        var playerNameString = "";

        let messageId = sesdoc.messageId;

        _.forEach(sesdoc.playersArray, playerData => {
            playerNameString += ( playerData.username || playerData.firstName + " " + playerData.lastName ) + "\n";
        });


        let message = "<b>Moderator:</b> " + (sesdoc.moderator.username || sesdoc.moderator.id) +
            "\n<b>Current Players:</b> " + sesdoc.playersArray.length +
            "\n" + playerNameString + (sesdoc.wordsDone ? "\n<b>Words have been chosen.</b>" : "");

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
        "\n" + playerNameString + (sesdoc.wordsDone ? "\n<b>Words have been chosen.</b>" : "");

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

var startGame = function(chatId, fromId){

    getSession(chatId, (err, sesdoc) => {
        console.log(sesdoc);
        if ((sesdoc.moderator.id === fromId) && !sesdoc.started)
        {
            let playersArray = _.shuffle(sesdoc.playersArray);

            console.log(playersArray);
            console.log(sesdoc.playersArray);

            parsePlayers(playersArray, chatId);
            startGameDB(chatId);
            initializeGhost(chatId);
        } else {
            return;
        }

        db.sessions.findAndModify({
            query: { chatId: chatId },
            update: {
                $set: {
                    ghostsLeft: gamePlayersArray[sesdoc.playersArray.length][2]
                }
            },
        }, (err, doc, lastErrorObject) => {
            return;
        });
    });


};

var startGamePhase2 = function(chatId, index){
    var rotArray;

    getSession(chatId, (err, sesdoc)=>{
         bot.sendMessage(chatId, "The ghost has chosen <b>" + sesdoc.playersArray[index].username || sesdoc.playersArray[index].firstName
             + "</b> to start. \n\nPlease PM @ghostgame_moderator with your phrase.", {parse: 'html'});
        rotArray = sesdoc.playersArray;
        rotate(rotArray, index);

        db.sessions.findAndModify({
            query: { chatId: chatId },
            update: {
                $set: {
                    playersArray: rotArray
                }
            },
        }, (err, doc, lastErrorObject) => {
            initializeRound(chatId, rotArray);
        });
     });
};

var initializeGhost = function(chatId){

    getSession(chatId, (err, sesdoc)=>{
        let pArray = sesdoc.playersArray;
        let keyArray = [];
        for (var i = 0; i< pArray.length; i++){
            keyArray.push([bot.inlineButton( sesdoc.playersArray[i].username || sesdoc.playersArray[i].firstName, {callback: chatId.toString()+'.'+i.toString()})]);
        }

        let markup = bot.inlineKeyboard(keyArray);

        getUserByRole(chatId, 'ghost', (err, userdoc)=>{
            canGhost[chatId] = userdoc.id;
            bot.sendMessage(userdoc.id, "The order of players goes from top to bottom, looping back to the top. Whom do you choose to start at?", {markup});
        });
    })
};

var initializeRound = function(chatId, playerArray){

    var playerStr = "";
    for (var i = 0; i < playerArray.length; i++){
        playerStr += (playerArray[i].username || playerArray[i].firstName) + "\n";
    };

    bot.sendMessage(chatId, "Round started. Player order:\n" + playerStr);
    gameInSession[chatId] = {playersArray: playerArray, ansArray: [], count: 0};
    console.log(gameInSession[chatId].playersArray);
    toAnswer[playerArray[0].id] = chatId.toString();
    bot.sendMessage(playerArray[0].id, "It is your turn. Please reply with a phrase.");
};

var nextPlayer = function(chatId){
    let gameSession = gameInSession[chatId];

    bot.sendMessage(chatId, "<b>" + (gameSession.playersArray[gameSession.count-1].username || gameSession.playersArray[gameSession.count-1].firstName)
        + "</b> says enigmatically: \n" + gameSession.ansArray[gameSession.count-1], {parse: 'html'});

    if (gameSession.count === gameSession.playersArray.length){
        questioningRound(chatId);
    } else {
        toAnswer[gameSession.playersArray[gameSession.count].id] = chatId.toString();
        bot.sendMessage(gameSession.playersArray[gameSession.count].id, "It is your turn. Please reply with a phrase.");
    }
};

var questioningRound = function(chatId){
    var thisId = chatId;

    let gameSession = gameInSession[chatId];
    let keyArray = [];
    var idArray = [];
    toVote[chatId] = [];

    let recapString = "The round is over. Here's a recap: \n";
    for (var i = 0; i < gameSession.playersArray.length; i++){
        recapString += "<b>" + (gameSession.playersArray[i].username || gameSession.playersArray[i].firstName)
            + "</b> phrase is: \n" + gameSession.ansArray[i] + "\n\n";
        keyArray.push([bot.inlineButton(gameSession.playersArray[i].username || gameSession.playersArray[i].firstName, {callback:chatId.toString()+'.v.'+i.toString()})]);
        idArray.push(gameSession.playersArray[i].id);
        toVote[chatId].push(0);
    };

    let markup = bot.inlineKeyboard(keyArray);
    canVote[chatId] = idArray;

    recapString += "Now, vote for who you think is the Ghost! You have 20 seconds...";
    bot.sendMessage(chatId, recapString, {parse: 'html', markup});


    setTimeout(function(){
        winningLogic(thisId);
    }, 20000);
};

var winningLogic = function(chatId){
    var thisId = parseInt(chatId);
    console.log(typeof(thisId));

    var max = _.max(toVote[thisId]);
    console.log(max);
    let lynched = _.indexOf(toVote[thisId], max);
    getUser(gameInSession[thisId].playersArray[lynched].id, (ses, usrdoc)=> {
        let role;
        if (usrdoc[thisId].role === "ghost"){
            role = 'ghost';
            bot.sendMessage(thisId, "With a total vote count of " + max.toString() + ", " + (gameInSession[thisId].playersArray[lynched].username || gameInSession[thisId].playersArray[lynched].firstName) + "has been lynched. His/her role was a...\n<b>" + role + "</b>.", {parse: 'html'});
            getSession(thisId, (err, sesdoc)=> {
                let ghostNo = sesdoc.ghostsLeft - 1;
                if (ghostNo === 0)
                {
                    bot.sendMessage(thisId, "The Villagers win!");
                    cleanUp(thisId);
                } else {
                    db.sessions.findAndModify({
                        query: {chatId: thisId},
                        update: {
                            $set: {
                                ghostsLeft: ghostNo
                            }
                        },
                    }, (err, doc, lastErrorObject) => {
                        var chat = chatId.toString() + '.alive';
                        db.users.findAndModify({
                            query: { id: gameInSession[chatId].playersArray[lynched].id },
                            update: {
                                $set: {
                                    [chat]: false
                                }
                            },
                        }, (err, doc, lastErrorObject) => {
                            return;
                        });

                        console.log('--old--:' + lynched.toString());
                        console.log(gameInSession[thisId].playersArray);
                        gameInSession[thisId].playersArray.splice(lynched,1);
                        console.log(gameInSession[chatId].playersArray);
                    });
                }
            });

        } else if (usrdoc[thisId].role === "villager1" || usrdoc[thisId].role === "villager2"){
            role = 'villager';
            bot.sendMessage(thisId, "With a total vote count of " + max.toString() + ", " + (gameInSession[chatId].playersArray[lynched].username || gameInSession[chatId].playersArray[lynched].firstName) +
                "has been lynched. His/her role was a...\n<b>" + role + "</b>.", {parse: 'html'});

            getSession(thisId, (err,sesdoc)=>{
                if (sesdoc.ghostsLeft >= gameInSession[chatId].count/2)
                {
                    bot.sendMessage(chatId, "The Ghost(s) win...");
                    cleanUp(chatId);
                } else{
                    console.log('--old--:' + lynched.toString());
                    console.log(gameInSession[chatId].playersArray);
                    gameInSession[chatId].playersArray.splice(lynched,1);
                    console.log(gameInSession[chatId].playersArray);

                    bot.sendMessage(chatId, "The villagers have failed to eliminate the ghost(s)... the game goes on.");
                    initializeRound(chatId, gameInSession[chatId].playersArray);
                }
            });
        } else {
            role = 'idiot';
            bot.sendMessage(thisId, "With a total vote count of " + max.toString() + ", " + (gameInSession[chatId].playersArray[lynched].username || gameInSession[chatId].playersArray[lynched].firstName) +
                "has been lynched. His/her role was a...\n<b>" + role + "</b>.", {parse: 'html'});

            console.log('--old--:' + lynched.toString());
            console.log(gameInSession[chatId].playersArray);
            gameInSession[chatId].playersArray.splice(lynched,1);
            console.log(gameInSession[chatId].playersArray);

            bot.sendMessage(thisId, "The villagers have failed to eliminate the ghost(s)... the game goes on.");
            initializeRound(thisId, gameInSession[thisId].playersArray);
        };
    });
};

var checkWinner = function(chatId){

    console.log('--checkwinner---');
    console.log(chatId);

    getSession(chatId, (err, sesdoc) =>{
        console.log(sesdoc);
       if (sesdoc.ghostsLeft === 0){
            //Humans Win
           bot.sendMessage(chatId, "The Villagers win...");
           cleanUp(chatId);
       } else if (sesdoc.ghostsLeft >= gameInSession[chatId].count/2){

       } else {
           //continue
           bot.sendMessage(chatId, "The villagers have failed to eliminate the ghost(s)... the game goes on.");
           initializeRound(chatId, gameInSession[chatId].playersArray);
       };
    });
};

var cleanUp = function(chatId){
    db.sessions.remove({ chatId: chatId });
    db.users.update({}, {$unset: {[chatId]: ''}}, {multi: true});
}

var parsePlayerW1 = function(player, chatId){
    var session = chatId.toString();

    db.users.findAndModify({
        query: { id: player.id },
        update: {
            $set: {
               [session] : {role: 'villager1', alive: true}
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });
    
    getSession(chatId, (err, sesdoc) => {
        bot.sendMessage(player.id, "You are a villager!\n This is your word: <b>" +
            sesdoc.words.word1 + "</b>\n\nRemember not to be overly specific and clue the ghost in too easily.", {parse: 'html'});
    })
};

var parsePlayerW2 = function(player, chatId){
    var session = chatId.toString();

    db.users.findAndModify({
        query: { id: player.id },
        update: {
            $set: {
                [session] : {role: 'villager2', alive: true}
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });

    getSession(chatId, (err, sesdoc) => {
        bot.sendMessage(player.id, "You are a villager!\n This is your word: <b>" +
            sesdoc.words.word2 + "</b>\n\nRemember not to be overly specific and clue the ghost in too easily.", {parse: 'html'});
    });
};

var parsePlayerGhost = function(player, chatId){
    var session = chatId.toString();

    db.users.findAndModify({
        query: { id: player.id },
        update: {
            $set: {
                [session] : {role: 'ghost', alive: true}
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });

    getSession(chatId, (err, sesdoc) => {
        bot.sendMessage(player.id, "You are a <b>GHOST</b>\n\nTry to deduce either word while blending in with the villagers.\n\nOnce you feel you have the answer, /guess it!", {parse: 'html'});
    });
};

var parsePlayerIdiot = function(player,chatId){
    var session = chatId.toString();

    db.users.findAndModify({
        query: { id: player.id },
        update: {
            $set: {
                [session] : {role: 'idiot', alive: true}
            }
        },
    }, (err, doc, lastErrorObject) => {
        return;
    });

    getSession(chatId, (err, sesdoc) => {
        bot.sendMessage(player.id, "You are the IDIOT!\n These are the words: <b>" +
            sesdoc.words.word1 + "</b>\n+<b>" + sesdoc.words.word2 + "</b>\nAct like the ghost in order to get voted out!.", {parse: 'html'});
    })
};

var parsePlayers = function(inputArray, chatId){
    let count = 0;
    for (var i = 0; i < 4; i++)
    {
        for (var j = 0; j < gamePlayersArray[inputArray.length][i]; j++){
            if (i === 0){  //word 1
                parsePlayerW1(inputArray[count], chatId);
            } else if (i === 1){ //word 2
                parsePlayerW2(inputArray[count], chatId);
            } else if (i === 2){ // ghost
                parsePlayerGhost(inputArray[count], chatId);
            } else { // idiot
                parsePlayerIdiot(inputArray[count], chatId);
            }
            count++;
        }
    }
};

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
                db.users.insert({id: msg.from.id, name: (msg.from.username || (msg.from.first_name)) });
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
        getUser(msg.from.id, (err, userdoc)=> {
            if (userdoc){
                getSession(msg.chat.id, function(err, sesdoc){
                    if (sesdoc && !sesdoc.started)
                    {
                        addPlayer(sesdoc._id, {
                            firstName: msg.from.first_name,
                            lastName: msg.from.last_name,
                            id: msg.from.id,
                            username: msg.from.username
                        }, msg.chat.id);
                        bot.sendMessage(msg.chat.id, (msg.from.username || msg.from.first_name) + " has joined the game. /join");
                    } else {
                        return;
                    }
                });
            } else {
                bot.sendMessage(msg.chat.id, msg.from.first_name + ', please PM me @ghostgame_bot before joining a game so that I can message you the role.');
            }
        });
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

bot.on(['/startgame'], msg=>{
    //write some message if cannot start

    //check for words selected
    //check for number of players

    console.log("----Start Game-----")
    bot.sendMessage(msg.chat.id, "game started.. ghost choosing first player.");
    startGame(msg.chat.id, msg.from.id);
});

bot.on(['/debug'], msg => {
    initializeGhost(msg.chat.id);
});

bot.on(['/cleanup'], msg => {
    console.log("cleaning up...");
    cleanUp(msg.chat.id);
})

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

    let match = sessionRegex.exec(msg.data);
    let match2 = voteRegex.exec(msg.data);

    if (match !== null) {

        console.log(match);
        let chatId = parseInt(match[1]);
        let index = parseInt(match[2]);

        if (canGhost[chatId] !== msg.from.id)
        {
            return;
        }
        delete canGhost[chatId];

        startGamePhase2(chatId, index);
        // getSession(chatId, (err, sesdoc)=>{
        //     bot.sendMessage(chatId, "pulled.. " + sesdoc.playersArray[index].username || sesdoc.playersArray[index].firstName);
        // });
        return;
    } else if (match2 !== null){
        console.log(match2);
        let chatId = (match2[1]);
        let index = (match2[2]);

        if (_.indexOf(canVote[chatId], msg.from.id) === -1)
        {
            return;
        }

        canVote[chatId] = _.without(canVote[chatId], msg.from.id);
        if (_.isEmpty(canVote[chatId])){
            delete canVote[chatId];
        }

        toVote[chatId][index] = toVote[chatId][index] + 1;
    } else if (msg.data === 'commands'){
        //return bot.sendMessage(msg.chat.id, "What is your <b>starting</b> location?", {parse: 'html', markup});
    } else if (msg.data === 'moderategame') {
        return moderateNewGame(msg.from.id, msg.from.username, msg.message.chat.id);
    } else if (msg.data ==='join'){
        getUser(msg.from.id, (err, userdoc)=> {
            if (userdoc){
                getSession(msg.message.chat.id, function(err, sesdoc){
                    if (sesdoc && !sesdoc.started)
                    {
                        addPlayer(sesdoc._id, {
                            firstName: msg.from.first_name,
                            lastName: msg.from.last_name,
                            id: msg.from.id,
                            username: msg.from.username
                        }, msg.message.chat.id);
                        bot.sendMessage(msg.message.chat.id, (msg.from.username || msg.from.first_name) + " has joined the game. /join");
                    } else {
                        return;
                    }
                });
            } else {
                bot.sendMessage(msg.message.chat.id, (msg.from.username || msg.from.first_name) + ', please PM me @ghostgame_bot before joining a game so that I can message you the role.');
            }
        });
    };
    //return bot.sendMessage(msg.from.id, "Pressed the " + msg.data + " button!");
});

bot.on(['/add_player_debug'], msg =>{
    getSession(msg.chat.id, function(err, sesdocs){
        if (sesdocs && !sesdocs.started)
        {
            addPlayer(sesdocs._id, dummyNames[0], msg.chat.id);
            addPlayer(sesdocs._id, dummyNames[1], msg.chat.id);
            addPlayer(sesdocs._id, dummyNames[2], msg.chat.id);
            addPlayer(sesdocs._id, dummyNames[3], msg.chat.id);
            addPlayer(sesdocs._id, dummyNames[4], msg.chat.id);
            bot.sendMessage(msg.chat.id, "Dummy players have joined the game. /join");
        } else {
            return;
        }
    }) ;
});

bot.on('text', msg => {

    if (msg.chat.type !== 'private')
    {
        return;
    }

    if (toAnswer[msg.from.id] !== undefined){
        var chatId = toAnswer[msg.from.id];
        gameInSession[chatId].ansArray.push(msg.text);
        gameInSession[chatId].count = gameInSession[chatId].count + 1;
        delete toAnswer[msg.from.id];
        nextPlayer(chatId);
    } else if (_.indexOf(word1, msg.from.id) !== -1){
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
            return bot.sendMessage(msg.from.id, "The two words you have inputted are:\n<b>" + w1 + "</b>\n<b>" + w2 + "</b>\n\nPlease enter /yes to confirm, /no to redo.", {parse: 'html'});
        });
    };
});

//Initialization
bot.connect();

