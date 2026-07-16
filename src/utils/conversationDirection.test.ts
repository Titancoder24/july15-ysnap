import { resolveConversationDirection } from './conversationDirection';

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
    transcript: 'This is a long sentence that should not be automatically resolved.'
  });
  assert('Long speech with missing language does not reuse previous', 
    t6.status === 'manual-required'
  );

  console.log("=========================================");
  console.log(`TESTS FINISHED: ${passed} PASSED, ${failed} FAILED`);
  console.log("=========================================");
}

runTests();
