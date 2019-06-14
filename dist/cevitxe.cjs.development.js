'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var automerge = _interopDefault(require('automerge'));
var buffer = require('buffer');
var hypercore = _interopDefault(require('hypercore'));
var crypto = _interopDefault(require('hypercore-crypto'));
var pump = _interopDefault(require('pump'));
var rai = _interopDefault(require('random-access-idb'));
var redux = require('redux');
var signalhub = _interopDefault(require('signalhub'));
var swarm = _interopDefault(require('webrtc-swarm'));

var APPLY_CHANGE = 'cevitxe/APPLY_CHANGE';

var adaptReducer = function adaptReducer(proxyReducer) {
  return function (state, _ref) {
    var type = _ref.type,
        payload = _ref.payload;

    switch (type) {
      case APPLY_CHANGE:
        {
          console.log('APPLY_CHANGE REDUCER!!!!', payload);
          var change = payload.change;
          var startingState = state;

          if (change[0].message === "initialize") {
            startingState = automerge.init();
            console.log('found initialize', change);
          }

          var newState = automerge.applyChanges(startingState, change);
          console.log(newState);
          return newState;
        }

      default:
        {
          var msg = type + ": " + JSON.stringify(payload);
          var fn = proxyReducer({
            type: type,
            payload: payload
          });
          return fn && state ? automerge.change(state, msg, fn) // return a modified Automerge object
          : state; // no matching change function was found, return state unchanged
        }
    }
  };
};

var initialize = function initialize(obj) {
  return automerge.change(automerge.init(), 'initialize', function (d) {
    for (var k in obj) {
      d[k] = obj[k];
    }
  });
};

var actions = {
  applyChange: function applyChange(change) {
    return {
      type: APPLY_CHANGE,
      payload: {
        change: change
      }
    };
  }
};

// This is a hack because I was getting errors verifying the remove signature
// I took the code from hypercore and am just always returning true for the verification
// We need to look deeper into why it's not signing properly or maybe just provide our
// own crypto methods here.

var mockCrypto = {
  sign: function sign(data, sk, cb) {
    return cb(null, crypto.sign(data, sk));
  },
  verify: function verify(_sig, _data, _pk, cb) {
    // Always say it's a valid signature (for testing)
    return cb(null, true);
  }
};

var keyString = 'ecc6212465b39a9a704d564f07da0402af210888e730f419a7faf5f347a33b3d';
var secretKeyString = '2234567890abcdef1234567880abcdef1234567890abcdef1234567890fedcba'; // hypercore seems to be happy when I turn the key into a discoveryKey,
// maybe we could get away with just using a Buffer (or just calling discoveryKey with a string?)

var key =
/*#__PURE__*/
crypto.discoveryKey(
/*#__PURE__*/
buffer.Buffer.from(keyString)); // hypercore doesn't seem to like the secret key being a discoveryKey,
// but rather just a Buffer

var secretKey =
/*#__PURE__*/
buffer.Buffer.from(secretKeyString); // This is currently a class but might make more sense as just a function

var CevitxeFeed = function CevitxeFeed() {
  var feed;
  var databaseName;
  var peerHubs;
  var reduxStore;

  var createStore = function createStore(options) {
    databaseName = options.databaseName || 'data';
    peerHubs = options.peerHubs || ['https://signalhub-jccqtwhdwc.now.sh/']; // Init an indexedDB
    // I'm constructing a name here using the key because re-using the same name
    // with different keys throws an error "Another hypercore is stored here"

    var todos = rai(databaseName + "-" + getKeyHex().substr(0, 12));

    var storage = function storage(filename) {
      return todos(filename);
    }; // Create a new hypercore feed


    feed = hypercore(storage, key, {
      secretKey: secretKey,
      valueEncoding: 'utf-8',
      crypto: mockCrypto
    });
    feed.on('error', function (err) {
      return console.log(err);
    });
    feed.on('ready', function () {
      console.log('ready', key.toString('hex'));
      console.log('discovery', feed.discoveryKey.toString('hex'));
      joinSwarm();
    });
    startStreamReader(); // Return the new Redux store

    reduxStore = createReduxStore(options); // Write the initial automerge state to the feed

    var storeState = reduxStore.getState();

    if (storeState !== null && storeState !== undefined) {
      var history = automerge.getChanges(automerge.init(), storeState);
      console.log('writing initial state to feed');
      feed.append(JSON.stringify(history));
    }

    return reduxStore;
  };

  var feedMiddleware = function feedMiddleware(store) {
    return function (next) {
      return function (action) {
        // feed.append(JSON.stringify(action.payload.action))
        var prevState = store.getState();
        var result = next(action);
        var nextState = store.getState();
        var existingState = prevState ? prevState : automerge.init();
        console.log('existingState', existingState);
        console.log('nextState', nextState);
        var changes = automerge.getChanges(existingState, nextState);
        changes.forEach(function (c) {
          return feed.append(JSON.stringify(c));
        });
        return result;
      };
    };
  }; // Read items from this and peer feeds,
  // then dispatch them to our redux store


  var startStreamReader = function startStreamReader() {
    // Wire up reading from the feed
    var stream = feed.createReadStream({
      live: true
    });
    stream.on('data', function (value) {
      // try {
      var change = JSON.parse(value);
      console.log('onData', change);
      reduxStore.dispatch(actions.applyChange(change)); // } catch (err) {
      //   console.log('feed read error', err)
      //   console.log('feed stream returned an unknown value', value)
      // }
    });
  }; // Join our feed to the swarm and accept peers


  var joinSwarm = function joinSwarm() {
    // could add option to disallow peer connectivity here
    var hub = signalhub(getKeyHex(), peerHubs);
    var sw = swarm(hub);
    sw.on('peer', onPeerConnect);
  }; // When a feed peer connects, replicate our feed to them


  var onPeerConnect = function onPeerConnect(peer, id) {
    console.log('peer', id, peer);
    pump(peer, feed.replicate({
      encrypt: false,
      live: true,
      upload: true,
      download: true
    }), peer);
  };

  var getKeyHex = function getKeyHex() {
    return key.toString('hex');
  };

  var createReduxStore = function createReduxStore(options) {
    // let enhancer: StoreEnhancer<any> | undefined
    var initialState; // let preloadedStateProvided: Boolean = false
    // // We received 2 params: reducer and enhancer
    // if (
    //   typeof preloadedState_orEnhancer === 'function' &&
    //   typeof enhancer_or_undefined === 'undefined'
    // ) {
    //   enhancer = preloadedState_orEnhancer
    //   initialState = undefined
    // } else {
    //   preloadedStateProvided = true
    //   enhancer = enhancer_or_undefined
    //   // Convert the plain object preloadedState to Automerge using initialize()
    //   initialState = initialize(preloadedState_orEnhancer as DeepPartial<
    //     S
    //   > | null)
    //   //initialState = preloadedState_orEnhancer as DeepPartial<S> | null
    //   console.log('initialized state', initialState)
    //   // TODO: Push the initial state operations to the feed
    // }

    var optionMiddlewares = options.middlewares ? options.middlewares : [];
    var middlewares = [].concat(optionMiddlewares, [feedMiddleware]); // check
    //if (enhancer !== undefined) middlewares.push(enhancer)

    console.log('adding a feed-enabled reducer here'); // Add the cevitxe reducer at the same level as the user's reducer
    // This allows us to operate at the root state and the user can still
    // have nested state reducers.
    // note: Casting these as Reducer may not be right
    // const combinedReducers = reduceReducers(
    //   null,
    //   adaptReducer as Reducer,
    //   reducer as Reducer
    // )
    // console.log('combined reducers', combinedReducers)

    if (options.preloadedState) {
      // Convert the plain object preloadedState to Automerge using initialize()
      initialState = initialize(options.preloadedState);
      console.log('initialized state', initialState); // TODO: Push the initial state operations to the feed

      console.log('creating redux store with initial state', initialState);
      return redux.createStore(options.reducer, initialState, redux.applyMiddleware.apply(void 0, middlewares));
    }

    console.log('creating redux store without initial state');
    return redux.createStore(options.reducer, redux.applyMiddleware.apply(void 0, middlewares));
  };

  return {
    createStore: createStore
  };
};

var feedInstance =
/*#__PURE__*/
CevitxeFeed();
var createStore = feedInstance.createStore; // export const { CevitxeFeed as Feed }

//export * from './actions'

exports.APPLY_CHANGE = APPLY_CHANGE;
exports.adaptReducer = adaptReducer;
exports.createStore = createStore;
exports.initialize = initialize;
exports.keyString = keyString;
exports.mockCrypto = mockCrypto;
exports.secretKeyString = secretKeyString;
//# sourceMappingURL=cevitxe.cjs.development.js.map
