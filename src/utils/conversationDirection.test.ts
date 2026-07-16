import { resolveConversationDirection } from './conversationDirection.ts';

function runTests() {
  console.log("=========================================");
  console.log("RUNNING CONVERSATION DIRECTION RESOLVER TESTS");
  console.log("=========================================");

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean) {
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.log(`❌ [FAIL] ${name}`);
      failed++;
    }
  }

  // Test 1: Tamil speech with pair ta/en
  const t1 = resolveConversationDirection({
    detectedLanguage: 'ta',
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'வணக்கம்'
  });
  assert('Tamil speech resolved to first panel', 
    t1.status === 'resolved' && 
    t1.sourceLanguage === 'ta' && 
    t1.targetLanguage === 'en' && 
    t1.sourcePanel === 'first'
  );

  // Test 2: English speech with pair ta/en
  const t2 = resolveConversationDirection({
    detectedLanguage: 'en',
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'Hello'
  });
  assert('English speech resolved to second panel', 
    t2.status === 'resolved' && 
    t2.sourceLanguage === 'en' && 
    t2.targetLanguage === 'ta' && 
    t2.sourcePanel === 'second'
  );

  // Test 3: Hindi detection with pair ta/en produces mismatch state
  const t3 = resolveConversationDirection({
    detectedLanguage: 'hi',
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'नमस्ते'
  });
  assert('Hindi detection produces language-mismatch', 
    t3.status === 'language-mismatch' && 
    t3.sourcePanel === 'unknown'
  );

  // Test 4: Missing language without previous direction requires manual selection
  const t4 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'Some random text'
  });
  assert('Missing language without history requires manual', 
    t4.status === 'manual-required' && 
    t4.sourcePanel === 'unknown'
  );

  // Test 5: Short ambiguous speech may reuse the previous direction
  const t5 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: 'ta',
    transcript: 'Ok'
  });
  assert('Short ambiguous speech reuses previous direction', 
    t5.status === 'resolved' && 
    t5.sourceLanguage === 'ta' && 
    t5.targetLanguage === 'en' && 
    t5.sourcePanel === 'first' && 
    t5.inferredFromPrevious === true
  );

  // Test 6: Long ambiguous speech does not reuse previous direction
  const t6 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: 'ta',
    transcript: 'bla bla bla bla bla bla bla bla bla bla bla bla bla bla bla bla'
  });
  assert('Long speech with missing language does not reuse previous', 
    t6.status === 'manual-required'
  );

  // Test 7: Unicode Tamil script detection override when detectedLanguage is null
  const t7 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'நல்லது, நன்றி!'
  });
  assert('Script detection resolves Tamil characters to first panel', 
    t7.status === 'resolved' && 
    t7.sourceLanguage === 'ta' && 
    t7.sourcePanel === 'first'
  );

  // Test 8: English stop word detection override when detectedLanguage is null
  const t8 = resolveConversationDirection({
    detectedLanguage: null,
    firstLanguage: 'ta',
    secondLanguage: 'en',
    previousDetectedLanguage: null,
    transcript: 'please translate this sentence'
  });
  assert('Stop-word detection resolves English words to second panel', 
    t8.status === 'resolved' && 
    t8.sourceLanguage === 'en' && 
    t8.sourcePanel === 'second'
  );

  console.log("=========================================");
  console.log(`TESTS FINISHED: ${passed} PASSED, ${failed} FAILED`);
  console.log("=========================================");
}

runTests();
